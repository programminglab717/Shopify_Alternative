// Apps' functions (DEV-07, ADR-868): WebAssembly modules checked and capped as Hatti takes them,
// and run as checkout runs them. Here, apart from the apps module, so that the developer's
// command line runs a function on their own machine exactly as Hatti does (ADR-927).
export { FunctionRunner, RUN_LIMITS, type RunResult } from './function-runner.js';
export { WASM_LIMITS, WasmError, capWasm, takeWasm } from './wasm.js';
