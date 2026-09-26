/* eslint-disable @typescript-eslint/no-require-imports -- a CommonJS preload loaded through --require has no other way in */
// Both test-owned preloads in one file: Next's dev server spawns its
// children with a NODE_OPTIONS that keeps one --require, so the tool
// harness's self-port preload and the render stub load through here.
require("./assistant-self-port.cjs");
require("./assistant-render-stub.cjs");
