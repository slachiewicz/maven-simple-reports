/*
 * Copyright 2026 The Apache Software Foundation
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

// Node 22+ ships a lazy, still-experimental global `localStorage` /
// `sessionStorage` getter. Vitest 2.1's jsdom environment only copies window
// properties that appear on its own hardcoded key list onto the global
// object, and that list predates Node's native Storage globals — so once
// `localStorage` already exists as a property on `globalThis` (courtesy of
// Node), Vitest skips copying jsdom's real implementation over it. The bare
// `localStorage` global then resolves to Node's own unconfigured version,
// which throws/warns instead of behaving like a Storage.
//
// Every jsdom test needs the real jsdom Storage (so app code that touches
// `localStorage`/`sessionStorage` works as it does in a browser), so rebind
// both globals to jsdom's own implementation here. `globalThis.jsdom` is set
// by Vitest's jsdom environment for the duration of each jsdom test file and
// absent for `environment: 'node'` files, so this is a no-op there.
interface JsdomGlobal {
  jsdom?: { window: Window }
}

const jsdomWindow = (globalThis as JsdomGlobal).jsdom?.window
if (jsdomWindow) {
  Object.defineProperty(globalThis, 'localStorage', {
    get: () => jsdomWindow.localStorage,
    configurable: true,
  })
  Object.defineProperty(globalThis, 'sessionStorage', {
    get: () => jsdomWindow.sessionStorage,
    configurable: true,
  })
}
