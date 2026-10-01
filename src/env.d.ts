/**
 * A non-module declaration file, so this `interface Window` merges with the DOM
 * lib's directly. Declaring it inside a module with `declare global` is fragile
 * once the imported type lives behind a path alias.
 */
interface Window {
  opencpics: import('@shared/bridge').OpenPicsBridge
}
