/* Copyright 2012 Mozilla Foundation
 *
 * Licensed under the Apache License, Version 2.0 (the "License");
 * you may not use this file except in compliance with the License.
 * You may obtain a copy of the License at
 *
 *     http://www.apache.org/licenses/LICENSE-2.0
 *
 * Unless required by applicable law or agreed to in writing, software
 * distributed under the License is distributed on an "AS IS" BASIS,
 * WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
 * See the License for the specific language governing permissions and
 * limitations under the License.
 */

import { arrayBuffersToBytes, MissingDataException } from "./core_utils.js";
import { assert } from "../shared/util.js";
import { MathClamp } from "../shared/math_clamp.js";
import { Stream } from "./stream.js";

class ChunkedStream extends Stream {
  progressiveDataLength = 0;

  _lastSuccessfulEnsureByteChunk = -1; // Single-entry cache

  _loadedChunks = new Set();

  // Sparse per-chunk storage, instead of one contiguous buffer sized to the
  // entire file: for multi-GB documents such a buffer would exceed the
  // maximum ArrayBuffer size supported by the JS engine.
  _chunkMap = new Map();

  _fullBytes = null; // Lazily assembled contiguous buffer, see `bytes` getter.

  // Single-entry cache of the chunk last read by `getByte`.
  _curChunk = null;

  _curChunkIdx = -1;

  constructor(length, chunkSize, manager) {
    super(
      /* arrayBuffer = */ new Uint8Array(0),
      /* start = */ 0,
      /* length = */ length,
      /* dict = */ null
    );
    // Replace the empty own-property set by the `Stream` constructor with a
    // lazily assembling getter: `bytes` provides a contiguous view of the
    // entire file, assembled only once the data is fully loaded (e.g. for
    // the GetData/SaveDocument code-paths). Note that for very large
    // documents this can exceed the maximum supported ArrayBuffer size --
    // an inherent limitation of exporting the entire file, unrelated to
    // regular (incremental) viewing.
    Object.defineProperty(this, "bytes", {
      get: () => {
        if (!this.isDataLoaded) {
          throw new Error(
            "ChunkedStream.bytes - the data is not fully loaded."
          );
        }
        this._fullBytes ??= this._readRange(0, this.end);
        return this._fullBytes;
      },
      configurable: true,
    });

    this.chunkSize = chunkSize;
    this.numChunks = Math.ceil(length / chunkSize);
    this.manager = manager;
  }

  /**
   * Store received bytes into the sparse per-chunk storage. The `begin`
   * offset does not need to be chunk-aligned (progressive data can arrive in
   * arbitrarily sized pieces); chunks are only marked as loaded once they
   * have been completely filled.
   */
  _storeRange(begin, bytes) {
    const { chunkSize } = this;
    const end = begin + bytes.byteLength;
    let bytesOffset = 0;

    while (begin < end) {
      const chunkIdx = Math.floor(begin / chunkSize);
      const inChunkOffset = begin - chunkIdx * chunkSize;
      const n = Math.min(chunkSize - inChunkOffset, end - begin);

      let chunk = this._chunkMap.get(chunkIdx);
      if (!chunk) {
        const size = Math.min(chunkSize, this.end - chunkIdx * chunkSize);
        chunk = new Uint8Array(size);
        this._chunkMap.set(chunkIdx, chunk);
      }
      chunk.set(bytes.subarray(bytesOffset, bytesOffset + n), inChunkOffset);

      if (inChunkOffset + n === chunk.byteLength) {
        // Since a value can only occur *once* in a `Set`, there's no need to
        // manually check `Set.prototype.has()` before adding the value here.
        this._loadedChunks.add(chunkIdx);
      }
      begin += n;
      bytesOffset += n;
    }
  }

  /**
   * Read a (loaded) range of bytes. Returns a `subarray` view when the range
   * lies within a single chunk, and a newly allocated copy otherwise. Missing
   * chunks yield zeros, matching the old zero-filled buffer behaviour.
   */
  _readRange(begin, end) {
    if (begin >= end) {
      return new Uint8Array(0);
    }
    const { chunkSize } = this;
    const beginChunk = Math.floor(begin / chunkSize);
    const endChunk = Math.floor((end - 1) / chunkSize);

    if (beginChunk === endChunk) {
      const chunk = this._chunkMap.get(beginChunk);
      const offset = begin - beginChunk * chunkSize;
      return chunk
        ? chunk.subarray(offset, offset + (end - begin))
        : new Uint8Array(end - begin);
    }
    const out = new Uint8Array(end - begin);
    for (let chunkIdx = beginChunk; chunkIdx <= endChunk; chunkIdx++) {
      const chunk = this._chunkMap.get(chunkIdx);
      if (!chunk) {
        continue;
      }
      const chunkStart = chunkIdx * chunkSize;
      const from = Math.max(begin - chunkStart, 0);
      const to = Math.min(end - chunkStart, chunk.byteLength);
      out.set(chunk.subarray(from, to), chunkStart + from - begin);
    }
    return out;
  }

  // If a particular stream does not implement one or more of these methods,
  // an error should be thrown.
  getMissingChunks() {
    const chunks = [];
    for (let chunk = 0, n = this.numChunks; chunk < n; ++chunk) {
      if (!this._loadedChunks.has(chunk)) {
        chunks.push(chunk);
      }
    }
    return chunks;
  }

  get numChunksLoaded() {
    return this._loadedChunks.size;
  }

  get isDataLoaded() {
    return this.numChunksLoaded === this.numChunks;
  }

  onReceiveData(begin, chunk) {
    const chunkSize = this.chunkSize;
    if (begin % chunkSize !== 0) {
      throw new Error(`Bad begin offset: ${begin}`);
    }

    // Using `this.length` is inaccurate here since `this.start` can be moved
    // (see the `moveStart` method).
    const end = begin + chunk.byteLength;
    if (end % chunkSize !== 0 && end !== this.end) {
      throw new Error(`Bad end offset: ${end}`);
    }

    if (typeof PDFJSDev === "undefined" || PDFJSDev.test("TESTING")) {
      assert(
        chunk instanceof ArrayBuffer,
        "onReceiveData - expected an ArrayBuffer."
      );
    }
    this._storeRange(begin, new Uint8Array(chunk));
  }

  onReceiveProgressiveData(data) {
    let position = this.progressiveDataLength;

    if (typeof PDFJSDev === "undefined" || PDFJSDev.test("TESTING")) {
      assert(
        data instanceof ArrayBuffer,
        "onReceiveProgressiveData - expected an ArrayBuffer."
      );
    }
    this._storeRange(position, new Uint8Array(data));
    position += data.byteLength;
    this.progressiveDataLength = position;
  }

  ensureByte(pos) {
    if (pos < this.progressiveDataLength) {
      return;
    }

    const chunk = Math.floor(pos / this.chunkSize);
    if (chunk > this.numChunks) {
      return;
    }
    if (chunk === this._lastSuccessfulEnsureByteChunk) {
      return;
    }

    if (!this._loadedChunks.has(chunk)) {
      throw new MissingDataException(pos, pos + 1);
    }
    this._lastSuccessfulEnsureByteChunk = chunk;
  }

  ensureRange(begin, end) {
    if (begin >= end) {
      return;
    }
    if (end <= this.progressiveDataLength) {
      return;
    }

    const beginChunk = Math.floor(begin / this.chunkSize);
    if (beginChunk > this.numChunks) {
      return;
    }
    const endChunk = Math.min(
      Math.floor((end - 1) / this.chunkSize) + 1,
      this.numChunks
    );
    for (let chunk = beginChunk; chunk < endChunk; ++chunk) {
      if (!this._loadedChunks.has(chunk)) {
        throw new MissingDataException(begin, end);
      }
    }
  }

  nextEmptyChunk(beginChunk) {
    const numChunks = this.numChunks;
    for (let i = 0; i < numChunks; ++i) {
      const chunk = (beginChunk + i) % numChunks; // Wrap around to beginning.
      if (!this._loadedChunks.has(chunk)) {
        return chunk;
      }
    }
    return null;
  }

  hasChunk(chunk) {
    return this._loadedChunks.has(chunk);
  }

  getByte() {
    const pos = this.pos;
    if (pos >= this.end) {
      return -1;
    }
    if (pos >= this.progressiveDataLength) {
      this.ensureByte(pos);
    }
    this.pos = pos + 1;

    const chunkIdx = Math.floor(pos / this.chunkSize);
    if (chunkIdx !== this._curChunkIdx) {
      this._curChunk = this._chunkMap.get(chunkIdx);
      this._curChunkIdx = chunkIdx;
    }
    // Once `ensureByte` succeeded the chunk is guaranteed to exist.
    return this._curChunk
      ? this._curChunk[pos - chunkIdx * this.chunkSize]
      : -1;
  }

  getBytes(length) {
    const pos = this.pos;
    const endPos = !length ? this.end : Math.min(pos + length, this.end);

    if (endPos > this.progressiveDataLength) {
      this.ensureRange(pos, endPos);
    }
    this.pos = endPos;
    return this._readRange(pos, endPos);
  }

  getByteRange(begin, end) {
    if (begin < 0) {
      begin = 0;
    }
    if (end > this.end) {
      end = this.end;
    }
    if (end > this.progressiveDataLength) {
      this.ensureRange(begin, end);
    }
    return this._readRange(begin, end);
  }

  makeSubStream(start, length, dict = null) {
    if (length) {
      if (start + length > this.progressiveDataLength) {
        this.ensureRange(start, start + length);
      }
    } else if (start >= this.progressiveDataLength) {
      // When the `length` is undefined you do *not*, under any circumstances,
      // want to fallback on calling `this.ensureRange(start, this.end)` since
      // that would force the *entire* PDF file to be loaded, thus completely
      // breaking the whole purpose of using streaming and/or range requests.
      //
      // However, not doing any checking here could very easily lead to wasted
      // time/resources during e.g. parsing, since `MissingDataException`s will
      // require data to be re-parsed, which we attempt to minimize by at least
      // checking that the *beginning* of the data is available here.
      this.ensureByte(start);
    }

    function ChunkedStreamSubstream() {}
    ChunkedStreamSubstream.prototype = Object.create(this);
    ChunkedStreamSubstream.prototype.getMissingChunks = function () {
      const chunkSize = this.chunkSize;
      const beginChunk = Math.floor(this.start / chunkSize);
      const endChunk = Math.floor((this.end - 1) / chunkSize) + 1;
      const missingChunks = [];
      for (let chunk = beginChunk; chunk < endChunk; ++chunk) {
        if (!this._loadedChunks.has(chunk)) {
          missingChunks.push(chunk);
        }
      }
      return missingChunks;
    };
    Object.defineProperty(ChunkedStreamSubstream.prototype, "isDataLoaded", {
      get() {
        return (
          this.numChunksLoaded === this.numChunks ||
          this.getMissingChunks().length === 0
        );
      },
      configurable: true,
    });

    const subStream = new ChunkedStreamSubstream();
    subStream.pos = subStream.start = start;
    subStream.end = start + length || this.end;
    subStream.dict = dict;
    return subStream;
  }

  getBaseStreams() {
    return [this];
  }
}

class ChunkedStreamManager {
  #aborted = false;

  currRequestId = 0;

  _chunksNeededByRequest = new Map();

  #loadedStreamCapability = Promise.withResolvers();

  _promisesByRequest = new Map();

  _requestsByChunk = new Map();

  constructor(pdfStream, args) {
    this.length = args.length;
    this.chunkSize = args.rangeChunkSize;
    this.stream = new ChunkedStream(this.length, this.chunkSize, this);
    this.pdfStream = pdfStream;
    this.disableAutoFetch = args.disableAutoFetch;
    this.msgHandler = args.msgHandler;
  }

  async sendRequest(begin, end) {
    const rangeReader = this.pdfStream.getRangeReader(begin, end);
    let chunks = [];

    while (true) {
      const { value, done } = await rangeReader.read();

      if (this.#aborted) {
        chunks = null;
        return; // Ignoring any data after abort.
      }
      if (done) {
        break;
      }
      if (typeof PDFJSDev === "undefined" || PDFJSDev.test("TESTING")) {
        assert(
          value instanceof ArrayBuffer,
          "sendRequest - expected an ArrayBuffer."
        );
      }
      chunks.push(value);
    }

    if (chunks.length === 0 && this.disableAutoFetch) {
      // The range request wasn't dispatched, see the "GetRangeReader" handler
      // in the `src/display/api.js` file.
      return;
    }
    const data = arrayBuffersToBytes(chunks);
    chunks = null;
    this.onReceiveData({ chunk: data.buffer, begin });
  }

  /**
   * Get all the chunks that are not yet loaded and group them into
   * contiguous ranges to load in as few requests as possible.
   */
  requestAllChunks(noFetch = false) {
    if (!noFetch) {
      const missingChunks = this.stream.getMissingChunks();
      this._requestChunks(missingChunks);
    }
    return this.#loadedStreamCapability.promise;
  }

  _requestChunks(chunks) {
    const requestId = this.currRequestId++;

    const chunksNeeded = new Set();
    this._chunksNeededByRequest.set(requestId, chunksNeeded);
    for (const chunk of chunks) {
      if (!this.stream.hasChunk(chunk)) {
        chunksNeeded.add(chunk);
      }
    }

    if (chunksNeeded.size === 0) {
      return Promise.resolve();
    }

    const capability = Promise.withResolvers();
    this._promisesByRequest.set(requestId, capability);

    const chunksToRequest = [];
    for (const chunk of chunksNeeded) {
      const requestIds = this._requestsByChunk.getOrInsertComputed(
        chunk,
        () => {
          chunksToRequest.push(chunk);
          return [];
        }
      );
      requestIds.push(requestId);
    }

    if (chunksToRequest.length > 0) {
      const groupedChunksToRequest = this.groupChunks(chunksToRequest);
      for (const groupedChunk of groupedChunksToRequest) {
        const begin = groupedChunk.beginChunk * this.chunkSize;
        const end = Math.min(
          groupedChunk.endChunk * this.chunkSize,
          this.length
        );
        this.sendRequest(begin, end).catch(capability.reject);
      }
    }

    return capability.promise.catch(reason => {
      if (this.#aborted) {
        return; // Ignoring any pending requests after abort.
      }
      throw reason;
    });
  }

  getStream() {
    return this.stream;
  }

  /**
   * Loads any chunks in the requested range that are not yet loaded.
   */
  requestRange(begin, end) {
    end = Math.min(end, this.length);

    const beginChunk = this.getBeginChunk(begin);
    const endChunk = this.getEndChunk(end);

    const chunks = [];
    for (let chunk = beginChunk; chunk < endChunk; ++chunk) {
      chunks.push(chunk);
    }
    return this._requestChunks(chunks);
  }

  requestRanges(ranges = []) {
    const chunksToRequest = [];
    for (const range of ranges) {
      const beginChunk = this.getBeginChunk(range.begin);
      const endChunk = this.getEndChunk(range.end);
      for (let chunk = beginChunk; chunk < endChunk; ++chunk) {
        if (!chunksToRequest.includes(chunk)) {
          chunksToRequest.push(chunk);
        }
      }
    }

    chunksToRequest.sort((a, b) => a - b);
    return this._requestChunks(chunksToRequest);
  }

  /**
   * Groups a sorted array of chunks into as few contiguous larger
   * chunks as possible.
   */
  groupChunks(chunks) {
    const groupedChunks = [];
    let beginChunk = -1;
    let prevChunk = -1;

    for (let i = 0, ii = chunks.length; i < ii; ++i) {
      const chunk = chunks[i];
      if (beginChunk < 0) {
        beginChunk = chunk;
      }

      if (prevChunk >= 0 && prevChunk + 1 !== chunk) {
        groupedChunks.push({ beginChunk, endChunk: prevChunk + 1 });
        beginChunk = chunk;
      }
      if (i + 1 === chunks.length) {
        groupedChunks.push({ beginChunk, endChunk: chunk + 1 });
      }

      prevChunk = chunk;
    }
    return groupedChunks;
  }

  onReceiveData(args) {
    const { chunkSize, length, stream } = this;

    const chunk = args.chunk;
    const isProgressive = args.begin === undefined;
    const begin = isProgressive ? stream.progressiveDataLength : args.begin;
    const end = begin + chunk.byteLength;

    const beginChunk = Math.floor(begin / chunkSize);
    const endChunk =
      end < length ? Math.floor(end / chunkSize) : Math.ceil(end / chunkSize);

    if (isProgressive) {
      stream.onReceiveProgressiveData(chunk);
    } else {
      stream.onReceiveData(begin, chunk);
    }

    if (stream.isDataLoaded) {
      this.#loadedStreamCapability.resolve(stream);
    }

    const loadedRequests = [];
    for (let curChunk = beginChunk; curChunk < endChunk; ++curChunk) {
      // The server might return more chunks than requested.
      const requestIds = this._requestsByChunk.get(curChunk);
      if (!requestIds) {
        continue;
      }
      this._requestsByChunk.delete(curChunk);

      for (const requestId of requestIds) {
        const chunksNeeded = this._chunksNeededByRequest.get(requestId);
        if (chunksNeeded.has(curChunk)) {
          chunksNeeded.delete(curChunk);
        }

        if (chunksNeeded.size > 0) {
          continue;
        }
        loadedRequests.push(requestId);
      }
    }

    // If there are no pending requests, automatically fetch the next
    // unfetched chunk of the PDF file.
    if (!this.disableAutoFetch && this._requestsByChunk.size === 0) {
      let nextEmptyChunk;
      if (stream.numChunksLoaded === 1) {
        // This is a special optimization so that after fetching the first
        // chunk, rather than fetching the second chunk, we fetch the last
        // chunk.
        const lastChunk = stream.numChunks - 1;
        if (!stream.hasChunk(lastChunk)) {
          nextEmptyChunk = lastChunk;
        }
      } else {
        nextEmptyChunk = stream.nextEmptyChunk(endChunk);
      }
      if (Number.isInteger(nextEmptyChunk)) {
        this._requestChunks([nextEmptyChunk]);
      }
    }

    for (const requestId of loadedRequests) {
      const capability = this._promisesByRequest.get(requestId);
      this._promisesByRequest.delete(requestId);
      capability.resolve();
    }

    this.msgHandler.send("DocProgress", {
      loaded: MathClamp(
        stream.numChunksLoaded * chunkSize,
        stream.progressiveDataLength,
        length
      ),
      total: length,
    });
  }

  getBeginChunk(begin) {
    return Math.floor(begin / this.chunkSize);
  }

  getEndChunk(end) {
    return Math.floor((end - 1) / this.chunkSize) + 1;
  }

  abort(reason) {
    this.#aborted = true;
    this.pdfStream?.cancelAllRequests(reason);

    for (const capability of this._promisesByRequest.values()) {
      capability.reject(reason);
    }
    this.#loadedStreamCapability.reject(reason);
  }
}

export { ChunkedStream, ChunkedStreamManager };
