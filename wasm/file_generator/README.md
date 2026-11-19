# Rust/WASM file generator

This crate builds the `file_generator_bg.wasm` browser module. Its exported entrypoint accepts CLI-style arguments:

```text
generate_file <size_mib>
```

The Rust module parses the size, generates pseudo-random test data in bounded 8 MiB chunks, and awaits each write before generating the next chunk. The size argument uses MiB: `1024` requests 1 GiB.

## Browser filesystem boundary

A browser WASM module cannot open a user-selected operating-system path with `std::fs`. The browser must first obtain permission through `showDirectoryPicker()` and create a `FileSystemWritableFileStream`. The small TypeScript adapter passes that stream and the command arguments into Rust. Rust owns argument parsing, data generation, chunk sizing, the write loop, and progress callbacks; TypeScript only handles browser APIs, UI, and closing or aborting the stream.

The output is written directly to the selected directory. It does not go through OPFS. Browser-internal staging may still occur when the writable stream is closed.

This is a `wasm-bindgen` browser module, not a standalone WASI process with shell or stdin/stdout. Building a WASI command runner for tools such as samtools would be a separate runtime and filesystem integration project; a browser file picker cannot be mounted automatically as a POSIX filesystem.

## Build

From the repository root:

```sh
npm run build:wasm
```

This compiles for `wasm32-unknown-unknown` and generates the `wasm-bindgen` JavaScript glue imported by the Analyser page. Generated target and package files are ignored; the Rust source and `Cargo.lock` are the reproducible inputs.
