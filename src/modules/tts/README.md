# tts

## build

Download and clone onnxruntime from microsoft.

``` sh
git clone --branch v1.23.0 --depth 1 https://github.com/microsoft/onnxruntime
cd onnxruntime
./build.sh --config Release --build_wasm_static_lib --skip_tests --minimal_build
```
