/* Copyright 2026 Mozilla Foundation
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

import { PDFDataRangeTransport } from "pdfjs-lib";

/**
 * A `PDFDataRangeTransport` implementation backed by a local `Blob`/`File`,
 * using `Blob.prototype.slice` for on-demand range reads. This avoids having
 * to download/read the entire file into memory, which is essential when
 * opening huge (multi-GB) local PDF documents through the "Open File" menu.
 */
class BlobRangeTransport extends PDFDataRangeTransport {
  #aborted = false;

  /**
   * @param {Blob} blob
   * @param {number} length
   * @param {Uint8Array|null} initialData
   */
  constructor(blob, length, initialData) {
    super(length, initialData);
    this._blob = blob;
  }

  /**
   * @param {number} begin
   * @param {number} end
   */
  requestDataRange(begin, end) {
    this._blob
      .slice(begin, end)
      .arrayBuffer()
      .then(
        buffer => {
          if (this.#aborted) {
            return;
          }
          this.onDataRange(begin, new Uint8Array(buffer));
        },
        reason => {
          if (this.#aborted) {
            return;
          }
          console.error(`BlobRangeTransport.requestDataRange: ${reason}`);
          this.abort();
        }
      );
  }

  abort() {
    this.#aborted = true;
  }
}

export { BlobRangeTransport };
