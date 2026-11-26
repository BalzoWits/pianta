// node_modules/oidn-webgpu/lib/tza.js
var TensorDesc = class {
  dims = [];
  paddedDims = [];
  layout = "x";
  dataType = "Float32";
  getByteSize() {
    let size = 1;
    for (const dim of this.paddedDims) {
      size *= dim;
    }
    if (this.dataType === "Float32") {
      size *= 4;
    } else if (this.dataType === "Float16") {
      size *= 2;
    }
    return size;
  }
};
var HostTensor = class {
  desc;
  data;
  constructor(desc, data) {
    this.desc = desc;
    this.data = data;
  }
};
var DataViewReader = class {
  _view;
  offset = 0;
  constructor(_view) {
    this._view = _view;
  }
  read(size) {
    const view = this._view;
    const offset = this.offset;
    this.offset += size;
    switch (size) {
      case 1:
        return view.getUint8(offset);
      case 2:
        return view.getUint16(offset, true);
      case 4:
        return view.getUint32(offset, true);
      case 8:
        return Number(view.getBigUint64(offset, true));
      default:
        throw new Error("unsupported read size");
    }
  }
};
function parseTZA(buffer2) {
  const input = new Uint8Array(buffer2);
  const viewReader = new DataViewReader(new DataView(buffer2));
  const magic = viewReader.read(2);
  if (magic !== 16855) {
    throw new Error("invalid or corrupted weights blob");
  }
  const majorVersion = viewReader.read(1);
  const minorVersion = viewReader.read(1);
  if (majorVersion !== 2) {
    throw new Error("unsupported weights blob version");
  }
  const tableOffset = viewReader.read(8);
  viewReader.offset = tableOffset;
  const numTensors = viewReader.read(4);
  const tensorMap = /* @__PURE__ */ new Map();
  for (let i = 0; i < numTensors; ++i) {
    const tensorDesc = new TensorDesc();
    const nameLen = viewReader.read(2);
    const name = new TextDecoder().decode(input.subarray(viewReader.offset, viewReader.offset + nameLen));
    viewReader.offset += nameLen;
    const ndims = viewReader.read(1);
    for (let j = 0; j < ndims; ++j) {
      tensorDesc.dims.push(viewReader.read(4));
    }
    tensorDesc.paddedDims = [...tensorDesc.dims];
    const layoutStr = new TextDecoder().decode(input.subarray(viewReader.offset, viewReader.offset + ndims));
    if (layoutStr === "oihw") {
      tensorDesc.layout = "oihw";
    }
    viewReader.offset += ndims;
    const dataType = String.fromCharCode(viewReader.read(1));
    if (dataType === "f") {
      tensorDesc.dataType = "Float32";
    } else if (dataType === "h") {
      tensorDesc.dataType = "Float16";
    } else {
      throw new Error("invalid tensor data type");
    }
    const tensorOffset = viewReader.read(8);
    const tensorData = input.slice(tensorOffset, tensorOffset + tensorDesc.getByteSize());
    tensorMap.set(name, new HostTensor(tensorDesc, tensorData));
  }
  return tensorMap;
}

// node_modules/oidn-webgpu/lib/WGPUComputePass.js
function isStorageParamsEqual(params, other) {
  return params.channels === other.channels;
}
var WORKGROUP_SIZE = 8;
var WGPUComputePass = class {
  autoUpdateOutputBuffer = true;
  _label;
  _device;
  _outputBuffers = {};
  _pipeline;
  _bindGroups = [];
  _needsUpdatePipeline = true;
  _needsResizeBuffer = true;
  _inputs = [];
  _outputs = [];
  _uniforms = [];
  _uniformBuffers = {};
  _width = 10;
  _height = 10;
  _execWidth;
  _execHeight;
  _csCode = "";
  _csMain;
  _csDefine;
  _groupOffsets = {
    inputs: 0,
    uniforms: 1,
    outputs: 2
  };
  constructor(label, device, opts) {
    this._label = label;
    this._device = device;
    this._csMain = opts.csMain;
    this._csDefine = opts.csDefine;
    this._inputs = opts.inputs;
    this._outputs = opts.outputs;
    this._uniforms = opts.uniforms;
    this.autoUpdateOutputBuffer = opts.autoUpdateOutputBuffer ?? true;
    opts.uniforms.forEach((uniform) => {
      this._uniformBuffers[uniform.label] = device.createBuffer({
        label: this._label,
        size: uniform.data.byteLength,
        usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST
      });
      this._device.queue.writeBuffer(this._uniformBuffers[uniform.label], 0, uniform.data);
    });
  }
  setCSCode({ csDefine, csMain }) {
    this._csDefine = csDefine;
    this._csMain = csMain;
    this._needsUpdatePipeline = true;
  }
  setSize(width, height) {
    width = Math.ceil(width);
    height = Math.ceil(height);
    const sizeChanged = width !== this._width || height !== this._height;
    this._width = width;
    this._height = height;
    if (sizeChanged) {
      this._needsResizeBuffer = true;
      this._needsUpdatePipeline = true;
    }
  }
  setExecuteSize(width, height) {
    width = Math.ceil(width);
    height = Math.ceil(height);
    this._execWidth = width;
    this._execHeight = height;
  }
  setOutputParams(outputParams) {
    if (this.autoUpdateOutputBuffer) {
      this._updateOutputBuffers(outputParams);
    }
    this._needsUpdatePipeline = true;
  }
  setOutputBuffers(outputBuffers) {
    this._outputBuffers = Object.keys(outputBuffers).reduce((obj, key) => {
      obj[key] = {
        buffer: outputBuffers[key],
        params: { channels: 4 }
      };
      return obj;
    }, {});
  }
  setUniform(label, data) {
    const buffer2 = this._uniformBuffers[label];
    this._device.queue.writeBuffer(buffer2, 0, data);
  }
  getOutput(name) {
    if (this._needsResizeBuffer && this.autoUpdateOutputBuffer) {
      this._resizeOutputBuffers();
      this._needsResizeBuffer = false;
    }
    return this._outputBuffers[name].buffer;
  }
  dispose(destroyOutputBuffers = true) {
    Object.keys(this._uniformBuffers).forEach((key) => {
      this._uniformBuffers[key].destroy();
    });
    if (destroyOutputBuffers) {
      Object.keys(this._outputBuffers).forEach((key) => {
        this._outputBuffers[key].buffer.destroy();
      });
    }
  }
  _createBuffer(params) {
    const byteLength = this._width * this._height * 4 * 4;
    return this._device.createBuffer({
      label: this._label,
      // webgpu needs buffer at least 80 bytes.
      size: Math.max(byteLength, 80),
      usage: GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_DST | GPUBufferUsage.COPY_SRC
    });
  }
  _resizeOutputBuffers() {
    const outputBuffers = this._outputBuffers;
    for (const key in outputBuffers) {
      const { buffer: buffer2, params } = outputBuffers[key];
      buffer2.destroy();
      outputBuffers[key].buffer = this._createBuffer(params);
    }
  }
  _updateOutputBuffers(outputParams) {
    const outputBuffers = this._outputBuffers;
    for (const key in outputParams) {
      const params = outputParams[key];
      if (!isStorageParamsEqual(params, outputBuffers[key]?.params || {})) {
        outputBuffers[key]?.buffer.destroy();
        const buffer2 = this._createBuffer(params);
        outputBuffers[key] = {
          buffer: buffer2,
          params
        };
      }
    }
  }
  _updatePipeline(inputParams, inputTypes) {
    if (!this._needsUpdatePipeline) {
      return;
    }
    this._needsUpdatePipeline = false;
    const device = this._device;
    const csCode = this._getFullCs(inputParams, inputTypes);
    if (csCode === this._csCode) {
      return;
    }
    this._csCode = csCode;
    this._pipeline = device.createComputePipeline({
      label: this._label,
      layout: "auto",
      compute: {
        module: device.createShaderModule({
          label: this._label,
          code: csCode
        }),
        entryPoint: "main"
      }
    });
    this._updateBindGroups();
  }
  _getFullCs(inputParams, inputTypes) {
    const inputs = this._inputs;
    const uniforms = this._uniforms;
    let offset = 0;
    const groupOffsets = this._groupOffsets = {
      inputs: 0,
      uniforms: 0,
      outputs: 0
    };
    if (inputs.length > 0) {
      offset++;
    }
    if (uniforms.length > 0) {
      groupOffsets.uniforms = offset;
      offset++;
    }
    groupOffsets.outputs = offset;
    const cs = `
${inputs.sort().map((inputName, idx) => {
      const bindingPrefix = `@group(${groupOffsets.inputs}) @binding(${idx}) `;
      const varName = `in_${inputName}`;
      return inputTypes[inputName] === "texture" ? `${bindingPrefix} var ${varName}: texture_2d<f32>;` : `${bindingPrefix} var<storage, read> ${varName}: array<vec${inputParams[inputName].channels}f>;`;
    }).join("\n")}
${this._uniforms.map((uniform, idx) => `@group(${groupOffsets.uniforms}) @binding(${idx}) var<uniform> ${uniform.label}: ${uniform.type};`).join("\n")}

${this._outputs.map((name, idx) => `@group(${groupOffsets.outputs}) @binding(${idx}) var<storage, read_write> out_${name}: array<vec${this._outputBuffers[name].params.channels}f>;`).join("\n")}
${this._csDefine ?? ""}
@compute @workgroup_size(${WORKGROUP_SIZE}, ${WORKGROUP_SIZE}, 1)
fn main(@builtin(global_invocation_id) globalId: vec3u) {
${this._csMain}
}
`;
    return cs;
  }
  _updateBindGroups() {
    const bindGroups = [];
    const device = this._device;
    const groupOffsets = this._groupOffsets;
    if (this._uniforms.length > 0) {
      bindGroups[groupOffsets.uniforms] = device.createBindGroup({
        label: this._label,
        layout: this._pipeline.getBindGroupLayout(groupOffsets.uniforms),
        entries: this._uniforms.map((uniform, idx) => ({
          binding: idx,
          resource: {
            buffer: this._uniformBuffers[uniform.label]
          }
        }))
      });
    }
    this._bindGroups = bindGroups;
  }
  createPass(commandEncoder, inputs) {
    if (this._needsResizeBuffer && this.autoUpdateOutputBuffer) {
      this._resizeOutputBuffers();
      this._needsResizeBuffer = false;
    }
    const inputTypes = this._inputs.reduce((obj, inputName) => {
      obj[inputName] = inputs[inputName].buffer ? "buffer" : "texture";
      return obj;
    }, {});
    this._updatePipeline(inputs, inputTypes);
    const groupOffsets = this._groupOffsets;
    if (this._inputs.length > 0) {
      this._bindGroups[groupOffsets.inputs] = this._device.createBindGroup({
        label: this._label,
        layout: this._pipeline.getBindGroupLayout(groupOffsets.inputs),
        entries: this._inputs.map((inputName, idx) => ({
          binding: idx,
          // TODO
          resource: inputs[inputName].buffer ? {
            buffer: inputs[inputName].buffer
          } : inputs[inputName].texture.createView()
        }))
      });
    }
    this._bindGroups[groupOffsets.outputs] = this._device.createBindGroup({
      label: this._label,
      layout: this._pipeline.getBindGroupLayout(groupOffsets.outputs),
      entries: this._outputs.map((bufferName, idx) => ({
        binding: idx,
        resource: {
          buffer: this._outputBuffers[bufferName].buffer
        }
      }))
    });
    const computePass = commandEncoder.beginComputePass();
    computePass.setPipeline(this._pipeline);
    this._bindGroups.forEach((bindGroup, idx) => {
      computePass.setBindGroup(idx, bindGroup);
    });
    computePass.dispatchWorkgroups(Math.ceil((this._execWidth ?? this._width) / WORKGROUP_SIZE), Math.ceil((this._execHeight ?? this._height) / WORKGROUP_SIZE), 1);
    computePass.end();
  }
};

// node_modules/oidn-webgpu/lib/sanitize.js
var FLT_MAX = 34028234663852886e22;
function sanitize(value, lo, hi) {
  return Number.isNaN(value) ? 0 : Math.min(Math.max(value, lo), hi);
}
var sanitizeWGSL = (
  /* wgsl */
  `
const FLT_MAX = 3.4028234663852886e38;
fn sanitize(v: vec3f, lo: f32, hi: f32) -> vec3f {
  let bits = bitcast<vec3u>(v);
  let magnitude = bits & vec3u(0x7fffffffu);
  let negative = (bits & vec3u(0x80000000u)) != vec3u(0u);
  let infinite = select(vec3f(hi), vec3f(lo), negative);
  let clamped = select(clamp(v, vec3f(lo), vec3f(hi)), infinite, magnitude == vec3u(0x7f800000u));
  return select(clamped, vec3f(0.0), magnitude > vec3u(0x7f800000u));
}
`
);

// node_modules/oidn-webgpu/lib/hdrTransfer.js
var a = 1412.83765;
var b = 1.64593172;
var c = 0.431384981;
var d = -0.00294139609;
var e = 0.192653254;
var f = 0.00626026094;
var g = 0.998620152;
var y0 = 15794576e-13;
var y1 = 0.0322087631;
var x0 = 0.00223151711;
var x1 = 0.370974749;
var yMax = 65504;
var puXMax = puForward(yMax);
var puNormScale = 1 / puXMax;
var puRcpNormScale = puXMax;
var logXMax = Math.log(yMax + 1);
var logNormScale = 1 / logXMax;
function puForward(y) {
  if (y <= y0)
    return a * y;
  if (y <= y1)
    return b * Math.pow(y, c) + d;
  return e * Math.log(y + f) + g;
}
function puInverse(x) {
  if (x <= x0)
    return x / a;
  if (x <= x1)
    return Math.pow((x - d) / b, 1 / c);
  return Math.exp((x - g) / e) - f;
}
function forward(y, transfer) {
  return transfer === "log" ? Math.log(y + 1) * logNormScale : puForward(y) * puNormScale;
}
function inverse(x, transfer) {
  return transfer === "log" ? Math.exp(x * logXMax) - 1 : puInverse(x * puRcpNormScale);
}
function hdrTransferFuncCPU({ data, channels, inputScale, transfer = "pu" }) {
  const newData = new Float32Array(data);
  for (let i = 0; i < newData.length; i += channels) {
    for (let channel = 0; channel < 3; channel++) {
      newData[i + channel] = forward(sanitize(newData[i + channel] * inputScale, 0, FLT_MAX), transfer);
    }
  }
  return newData;
}
function hdrTransferFuncInverseCPU({ data, channels, inputScale, transfer = "pu" }) {
  const newData = new Float32Array(data);
  const outputScale = 1 / inputScale;
  for (let i = 0; i < newData.length; i += channels) {
    for (let channel = 0; channel < 3; channel++) {
      newData[i + channel] = inverse(sanitize(newData[i + channel], 0, FLT_MAX), transfer) * outputScale;
    }
  }
  return newData;
}
function avgLogLum({ data, channels }) {
  let totalLuminance = 0;
  for (let i = 0; i < data.length; i += channels) {
    const r = sanitize(data[i], 0, FLT_MAX);
    const g2 = sanitize(data[i + 1], 0, FLT_MAX);
    const b2 = sanitize(data[i + 2], 0, FLT_MAX);
    const lum = 0.212671 * r + 0.71516 * g2 + 0.072169 * b2;
    totalLuminance += Math.log2(lum + 1e-4);
  }
  const numPixels = data.length / channels;
  const averageLuminance = totalLuminance / numPixels;
  const key = 0.18;
  return key / Math.pow(2, averageLuminance);
}
var transferConstantsWGSL = `
const a = ${a};
const b = ${b};
const c = ${c};
const d = ${d};
const e = ${e};
const f = ${f};
const g = ${g};
const y0 =${y0};
const y1 =${y1};
const x0 =${x0};
const x1 =${x1};

const normScale = ${puNormScale};
const rcpNormScale = ${puRcpNormScale};
`;
function hdrForwardWGSL(transfer) {
  const forwardCode = transfer === "log" ? `fn HDRForward(y: f32) -> f32 { return log(y + 1.0) * logNormScale; }` : `fn HDRForward(y: f32) -> f32 {
  if (y <= y0) { return a * y * normScale; }
  else if (y <= y1) { return (b * pow(y, c) + d) * normScale; }
  else { return (e * log(y + f) + g) * normScale; }
}`;
  return (
    /* wgsl */
    `
${transferConstantsWGSL}
const logXMax = ${logXMax};
const logNormScale = ${logNormScale};
${forwardCode}`
  );
}
function hdrInverseWGSL(transfer) {
  const inverseCode = transfer === "log" ? `fn HDRInverse(x: f32) -> f32 { return exp(x * logXMax) - 1.0; }` : `fn HDRInverse(x: f32) -> f32 {
  let y = x * rcpNormScale;
  if (y <= x0) { return y / a; }
  else if (y <= x1) { return pow((y - d) / b, 1 / c); }
  else { return exp((y - g) / e) - f; }
}`;
  return (
    /* wgsl */
    `
${transferConstantsWGSL}
const logXMax = ${logXMax};
${inverseCode}
`
  );
}

// node_modules/oidn-webgpu/lib/process.js
var Tile = class {
  x;
  y;
  width;
  height;
  constructor(x, y, width, height) {
    this.x = x;
    this.y = y;
    this.width = width;
    this.height = height;
  }
};
var GPUDataProcess = class {
  _device;
  _isHDR;
  _hdrTransfer;
  _inputPassAux;
  _inputPassColor;
  _outputPass;
  _copyPass;
  _isInputTexture;
  _denoiseAlpha;
  constructor(_device, _isHDR, _hdrTransfer = "pu") {
    this._device = _device;
    this._isHDR = _isHDR;
    this._hdrTransfer = _hdrTransfer;
    const commonUniforms = [
      {
        label: "inputScale",
        type: "f32",
        data: new Float32Array([1])
      },
      {
        label: "inputSize",
        type: "vec2i",
        data: new Int32Array(2)
      },
      {
        label: "outputSize",
        type: "vec2i",
        data: new Int32Array(2)
      },
      {
        label: "inputOffset",
        type: "vec2i",
        data: new Int32Array(2)
      }
    ];
    this._inputPassAux = new WGPUComputePass("inputPassAux", this._device, {
      inputs: ["color", "albedo", "normal"],
      outputs: ["color", "albedo", "normal"],
      uniforms: commonUniforms,
      csDefine: "",
      csMain: ``
    });
    this._inputPassColor = new WGPUComputePass("inputPassColor", this._device, {
      inputs: ["color"],
      outputs: ["color"],
      uniforms: commonUniforms,
      csDefine: "",
      csMain: ``
    });
    this._outputPass = new WGPUComputePass("outputPass", this._device, {
      inputs: ["color", "raw"],
      outputs: ["color"],
      uniforms: [
        {
          label: "inputScale",
          type: "f32",
          data: new Float32Array([1])
        },
        {
          label: "inputSize",
          type: "vec2i",
          data: new Int32Array(2)
        },
        {
          label: "outputSize",
          type: "vec2i",
          data: new Int32Array(2)
        },
        {
          label: "imageSize",
          type: "vec2i",
          data: new Int32Array(2)
        },
        {
          label: "inputOffset",
          type: "vec2i",
          data: new Int32Array(2)
        },
        {
          label: "outputOffset",
          type: "vec2i",
          data: new Int32Array(2)
        }
      ],
      csDefine: "",
      csMain: ``
    });
    this._copyPass = new WGPUComputePass("copyPass", this._device, {
      inputs: ["color"],
      outputs: ["color"],
      autoUpdateOutputBuffer: false,
      uniforms: [
        {
          label: "size",
          type: "vec2i",
          data: new Int32Array(2)
        }
      ],
      csMain: (
        /*wgsl*/
        `
if (any(globalId.xy >= vec2u(size))) {
  return;
}
let outIdx = i32(globalId.x + globalId.y * u32(size.x));
out_color[outIdx] = textureLoad(in_color, globalId.xy, 0);
`
      )
    });
    this._inputPassAux.setOutputParams({
      color: { channels: 3 },
      albedo: { channels: 3 },
      normal: { channels: 3 }
    });
    this._inputPassColor.setOutputParams({
      color: { channels: 3 }
    });
    this._outputPass.setOutputParams({
      color: { channels: 4 }
    });
  }
  _updatePasses(isInputTexture, denoiseAlpha = false) {
    if (this._isInputTexture === isInputTexture && this._denoiseAlpha === denoiseAlpha) {
      return;
    }
    this._isInputTexture = isInputTexture;
    this._denoiseAlpha = denoiseAlpha;
    const isHDR = this._isHDR;
    const commonCSDefine = hdrForwardWGSL(this._hdrTransfer) + sanitizeWGSL;
    function readInputCode(inputName) {
      return isInputTexture ? `textureLoad(in_${inputName}, vec2u(inputPosition), 0)` : `in_${inputName}[inIdx]`;
    }
    function inputBoundsCode(outputNames) {
      const zeroStores = outputNames.map((name) => `out_${name}[outIdx] = vec3f(0.0);`).join("\n  ");
      return (
        /* wgsl */
        `
let x = i32(globalId.x);
let y = i32(globalId.y);
if (x >= outputSize.x || y >= outputSize.y) {
  return;
}
let outIdx = y * outputSize.x + x;
let inputPosition = vec2i(x, y) + inputOffset;
// Padding is zero in network space, including when denoising inverted alpha.
if (any(inputPosition < vec2i(0)) || any(inputPosition >= inputSize)) {
  ${zeroStores}
  return;
}
`
      );
    }
    const commonCSMain = (
      /* wgsl */
      `
let inIdx = inputPosition.y * inputSize.x + inputPosition.x;
let col = ${readInputCode("color")};

if (${denoiseAlpha}) {
  // Denoise the inversed alpha. Or the anti aliased edge will be too dark after denoised
  out_color[outIdx] = sanitize(vec3f(1.0 - col.a), 0.0, 1.0);
}
else if (${isHDR}) {
  let scaled = sanitize(col.rgb * inputScale, 0.0, FLT_MAX);
  out_color[outIdx] = vec3f(HDRForward(scaled.r), HDRForward(scaled.g), HDRForward(scaled.b));
}
else {
  out_color[outIdx] = sanitize(col.rgb, 0.0, 1.0);
}
`
    );
    this._inputPassAux.setCSCode({
      csDefine: commonCSDefine,
      csMain: (
        /* wgsl */
        `
${inputBoundsCode(["color", "albedo", "normal"])}
${commonCSMain}
let alb = ${readInputCode("albedo")};
let nor = ${readInputCode("normal")};
// Normals arrive [0, 1]-encoded, so OIDN's [-1, 1] clamp becomes [0, 1].
out_normal[outIdx] = sanitize(nor.rgb, 0.0, 1.0);
out_albedo[outIdx] = sanitize(alb.rgb, 0.0, 1.0);
  `
      )
    });
    this._inputPassColor.setCSCode({
      csDefine: commonCSDefine,
      csMain: (
        /* wgsl */
        `
${inputBoundsCode(["color"])}
${commonCSMain}
`
      )
    });
    this._outputPass.setCSCode({
      csDefine: hdrInverseWGSL(this._hdrTransfer) + sanitizeWGSL,
      csMain: (
        /* wgsl */
        `
let x = i32(globalId.x);
let y = i32(globalId.y);
if (x >= outputSize.x || y >= outputSize.y) {
  return;
}
let inIdx = (y + inputOffset.y) * inputSize.x + x + inputOffset.x;
let outIdx = (y + outputOffset.y) * imageSize.x + x + outputOffset.x;
let col = in_color[inIdx];
let raw = ${isInputTexture ? "textureLoad(in_raw, globalId.xy + vec2u(outputOffset), 0)" : "in_raw[outIdx]"};

// The network output may contain negative values or NaNs.
let denoised = sanitize(col.rgb, 0.0, ${isHDR && !denoiseAlpha ? "FLT_MAX" : "1.0"});
if (${denoiseAlpha}) {
  out_color[outIdx] = vec4f(raw.rgb, 1.0 - denoised.r);
}
else if (${isHDR}) {
  out_color[outIdx] = vec4f(
    vec3f(HDRInverse(denoised.r), HDRInverse(denoised.g), HDRInverse(denoised.b)) / inputScale,
    // Pick the alpha
    raw.a
  );
}
else {
  out_color[outIdx] = vec4f(denoised, raw.a);
}
`
      )
    });
  }
  setImageSize(w, h) {
    this._inputPassAux.setUniform("inputSize", new Int32Array([w, h]));
    this._inputPassColor.setUniform("inputSize", new Int32Array([w, h]));
    this._outputPass.setUniform("imageSize", new Int32Array([w, h]));
    this._outputPass.setSize(w, h);
    this._copyPass.setSize(w, h);
    this._copyPass.setUniform("size", new Int32Array([w, h]));
  }
  setInputTile(tile) {
    const size = new Int32Array([tile.width, tile.height]);
    [this._inputPassAux, this._inputPassColor].forEach((inputPass) => {
      inputPass.setUniform("inputOffset", new Int32Array([tile.x, tile.y]));
      inputPass.setUniform("outputSize", size);
      inputPass.setSize(size[0], size[1]);
    });
    this._outputPass.setUniform("inputSize", size);
  }
  setOutputTile(dstTile, srcTile) {
    const outputPass = this._outputPass;
    const size = new Int32Array([dstTile.width, dstTile.height]);
    const dx = dstTile.x - srcTile.x;
    const dy = dstTile.y - srcTile.y;
    outputPass.setUniform("outputSize", size);
    outputPass.setUniform("inputOffset", new Int32Array([dx, dy]));
    outputPass.setUniform("outputOffset", new Int32Array([dstTile.x, dstTile.y]));
    outputPass.setExecuteSize(size[0], size[1]);
  }
  forward(colorBuffer, albedoBuffer, normalBuffer, denoiseAlpha) {
    const isInputTexture = colorBuffer instanceof GPUTexture;
    this._updatePasses(isInputTexture, denoiseAlpha);
    const inputPassAux = this._inputPassAux;
    const inputPassColor = this._inputPassColor;
    const commandEncoder = this._device.createCommandEncoder();
    function createInput(bufferOrTex) {
      return bufferOrTex instanceof GPUTexture ? {
        texture: bufferOrTex,
        channels: 4
      } : {
        buffer: bufferOrTex,
        channels: 4
      };
    }
    if (albedoBuffer && normalBuffer) {
      inputPassAux.createPass(commandEncoder, {
        color: createInput(colorBuffer),
        albedo: createInput(albedoBuffer),
        normal: createInput(normalBuffer)
      });
    } else {
      inputPassColor.createPass(commandEncoder, {
        color: createInput(colorBuffer)
      });
    }
    this._device.queue.submit([commandEncoder.finish()]);
    return albedoBuffer && normalBuffer ? {
      color: inputPassAux.getOutput("color"),
      albedo: inputPassAux.getOutput("albedo"),
      normal: inputPassAux.getOutput("normal")
    } : {
      color: inputPassColor.getOutput("color")
    };
  }
  inverse(buffer2, raw) {
    const device = this._device;
    const commandEncoder = device.createCommandEncoder();
    const outputGPUPass = this._outputPass;
    outputGPUPass.createPass(commandEncoder, {
      color: { buffer: buffer2, channels: 4 },
      raw: raw instanceof GPUBuffer ? { buffer: raw, channels: 4 } : { texture: raw, channels: 4 }
    });
    this._device.queue.submit([commandEncoder.finish()]);
    return outputGPUPass.getOutput("color");
  }
  copyInputDataToOutput(inputColorBuffer) {
    const encoder = this._device.createCommandEncoder();
    const outputGPUPass = this._outputPass;
    const colorBuffer = outputGPUPass.getOutput("color");
    const copyPass = this._copyPass;
    if (inputColorBuffer instanceof GPUTexture) {
      copyPass.setOutputBuffers({
        color: colorBuffer
      });
      copyPass.createPass(encoder, {
        color: { texture: inputColorBuffer, channels: 4 }
      });
    } else {
      encoder.copyBufferToBuffer(inputColorBuffer, 0, colorBuffer, 0, colorBuffer.size);
    }
    this._device.queue.submit([encoder.finish()]);
  }
  dispose() {
    this._outputPass.dispose();
    this._inputPassAux.dispose();
    this._inputPassColor.dispose();
    this._copyPass.dispose(false);
  }
};

// node_modules/oidn-webgpu/lib/tileScheduler.js
var defaultMinTileSize = 256;
var defaultInitialTileSize = 432;
var defaultTargetTileTimeMs = 16;
var defaultAdjustmentStep = 16;
var OIDN_TILE_ALIGNMENT = 16;
function alignUp(value, alignment) {
  return Math.ceil(value / alignment) * alignment;
}
function alignDown(value, alignment) {
  return Math.floor(value / alignment) * alignment;
}
function partitionRange(length, parts, index) {
  const start = Math.round(index * length / parts);
  const end = Math.round((index + 1) * length / parts);
  return { start, end };
}
function alignRangeWithinImage(start, end, imageSize, minimumSize = 0) {
  const currentSize = end - start;
  const alignedSize = Math.max(minimumSize, alignUp(currentSize, OIDN_TILE_ALIGNMENT));
  let alignedStart = start - Math.floor((alignedSize - currentSize) / 2);
  alignedStart = clamp(alignedStart, 0, Math.max(0, imageSize - alignedSize));
  return { start: alignedStart, end: alignedStart + alignedSize };
}
function planTileGrid(width, height, maxTileSize, overlap) {
  if (!Number.isInteger(width) || width <= 0 || !Number.isInteger(height) || height <= 0) {
    throw new Error("Tile grid dimensions must be positive integers");
  }
  if (!Number.isFinite(maxTileSize) || maxTileSize <= 0) {
    throw new Error("Maximum tile size must be positive");
  }
  if (!Number.isFinite(overlap) || overlap < 0) {
    throw new Error("Tile overlap must be non-negative");
  }
  const alignedMaximum = Math.max(OIDN_TILE_ALIGNMENT, alignDown(maxTileSize, OIDN_TILE_ALIGNMENT));
  const alignedOverlap = alignUp(overlap, OIDN_TILE_ALIGNMENT);
  const columns = Math.max(1, Math.ceil(width / alignedMaximum));
  const rows = Math.max(1, Math.ceil(height / alignedMaximum));
  const tiles = [];
  let maxOutputWidth = 0;
  let maxOutputHeight = 0;
  for (let row = 0; row < rows; row++) {
    const outputY = partitionRange(height, rows, row);
    for (let column = 0; column < columns; column++) {
      const outputX = partitionRange(width, columns, column);
      const desiredInputX = {
        start: column === 0 ? outputX.start : Math.max(0, outputX.start - alignedOverlap),
        end: column === columns - 1 ? outputX.end : Math.min(width, outputX.end + alignedOverlap)
      };
      const desiredInputY = {
        start: row === 0 ? outputY.start : Math.max(0, outputY.start - alignedOverlap),
        end: row === rows - 1 ? outputY.end : Math.min(height, outputY.end + alignedOverlap)
      };
      const inputX = alignRangeWithinImage(desiredInputX.start, desiredInputX.end, width);
      const inputY = alignRangeWithinImage(desiredInputY.start, desiredInputY.end, height);
      const output = {
        x: outputX.start,
        y: outputY.start,
        width: outputX.end - outputX.start,
        height: outputY.end - outputY.start
      };
      const input = {
        x: inputX.start,
        y: inputY.start,
        width: inputX.end - inputX.start,
        height: inputY.end - inputY.start
      };
      maxOutputWidth = Math.max(maxOutputWidth, output.width);
      maxOutputHeight = Math.max(maxOutputHeight, output.height);
      tiles.push({ column, row, input, output });
    }
  }
  const inputShapes = () => new Set(tiles.map(({ input }) => `${input.width}x${input.height}`));
  if (inputShapes().size > 2) {
    const maximumInputWidth = Math.max(...tiles.map(({ input }) => input.width));
    const maximumInputHeight = Math.max(...tiles.map(({ input }) => input.height));
    const uniformWidthPixelCount = tiles.reduce((sum, { input }) => sum + maximumInputWidth * input.height, 0);
    const uniformHeightPixelCount = tiles.reduce((sum, { input }) => sum + input.width * maximumInputHeight, 0);
    if (uniformWidthPixelCount <= uniformHeightPixelCount) {
      for (const tile of tiles) {
        const range = alignRangeWithinImage(tile.input.x, tile.input.x + tile.input.width, width, maximumInputWidth);
        tile.input.x = range.start;
        tile.input.width = range.end - range.start;
      }
    } else {
      for (const tile of tiles) {
        const range = alignRangeWithinImage(tile.input.y, tile.input.y + tile.input.height, height, maximumInputHeight);
        tile.input.y = range.start;
        tile.input.height = range.end - range.start;
      }
    }
  }
  const finalInputShapes = inputShapes();
  const inputPixelCount = tiles.reduce((sum, { input }) => sum + input.width * input.height, 0);
  return {
    columns,
    rows,
    overlap: alignedOverlap,
    maxOutputWidth,
    maxOutputHeight,
    inputPixelCount,
    inputShapeCount: finalInputShapes.size,
    tiles
  };
}
function clamp(value, min, max) {
  return Math.min(Math.max(value, min), max);
}
function percentile(values2, fraction) {
  const sorted = [...values2].sort((a2, b2) => a2 - b2);
  return sorted[Math.ceil(sorted.length * fraction) - 1];
}
var DynamicTileController = class {
  enabled;
  maxTileSize;
  minTileSize;
  targetTileTimeMs;
  _tileSize;
  _adjustmentStep;
  _smoothedTileTimeMs;
  _completeExecutionsSinceChange = 0;
  constructor(maxTileSize, setting = true) {
    const options = typeof setting === "object" ? setting : {};
    this.enabled = setting !== false;
    this.maxTileSize = Math.max(OIDN_TILE_ALIGNMENT, alignDown(maxTileSize, OIDN_TILE_ALIGNMENT));
    this.minTileSize = clamp(alignUp(options.minTileSize ?? defaultMinTileSize, OIDN_TILE_ALIGNMENT), OIDN_TILE_ALIGNMENT, this.maxTileSize);
    this.targetTileTimeMs = Math.max(1, options.targetTileTimeMs ?? defaultTargetTileTimeMs);
    this._adjustmentStep = Math.max(OIDN_TILE_ALIGNMENT, alignUp(options.adjustmentStep ?? defaultAdjustmentStep, OIDN_TILE_ALIGNMENT));
    this._tileSize = this.enabled ? clamp(alignUp(options.initialTileSize ?? defaultInitialTileSize, OIDN_TILE_ALIGNMENT), this.minTileSize, this.maxTileSize) : this.maxTileSize;
  }
  get tileSize() {
    return this._tileSize;
  }
  /** Returns true when the next execution should use a different tile size. */
  observe(tileTimesMs) {
    if (!this.enabled || tileTimesMs.length === 0)
      return false;
    const validTimes = tileTimesMs.filter((duration) => Number.isFinite(duration) && duration >= 0);
    if (validTimes.length === 0)
      return false;
    const representativeTimes = validTimes.length >= 3 ? validTimes.slice(1) : validTimes;
    const observedTime = percentile(representativeTimes, 0.75);
    this._smoothedTileTimeMs = this._smoothedTileTimeMs === void 0 ? observedTime : this._smoothedTileTimeMs * 0.65 + observedTime * 0.35;
    this._completeExecutionsSinceChange++;
    if (this._completeExecutionsSinceChange < 2)
      return false;
    let nextTileSize = this._tileSize;
    if (this._smoothedTileTimeMs > this.targetTileTimeMs * 1.25) {
      nextTileSize -= this._adjustmentStep;
    } else if (this._smoothedTileTimeMs < this.targetTileTimeMs * 0.65) {
      nextTileSize += this._adjustmentStep;
    }
    nextTileSize = clamp(alignUp(nextTileSize, OIDN_TILE_ALIGNMENT), this.minTileSize, this.maxTileSize);
    if (nextTileSize === this._tileSize)
      return false;
    this._tileSize = nextTileSize;
    this._smoothedTileTimeMs = void 0;
    this._completeExecutionsSinceChange = 0;
    return true;
  }
};

// node_modules/oidn-webgpu/lib/modelSpec.js
function conv(id, input) {
  return {
    op: "conv2d",
    id,
    input,
    weight: `${id}.weight`,
    bias: `${id}.bias`,
    activation: "relu",
    padding: "same"
  };
}
function pool(id, input) {
  return {
    op: "maxPool2d",
    id,
    input,
    size: 2,
    stride: 2,
    padding: "same"
  };
}
function upsample(id, input) {
  return {
    op: "upsample2d",
    id,
    input,
    scale: 2,
    mode: "nearest"
  };
}
function concat(id, first, second) {
  return {
    op: "concat",
    id,
    inputs: [first, second],
    axis: "channels"
  };
}
var OIDN_UNET_SMALL_SPEC = {
  schemaVersion: 1,
  id: "oidn-unet-small-v1",
  family: "oidn-unet-small",
  input: "input",
  output: "dec_conv0",
  receptiveField: 174,
  nodes: [
    conv("enc_conv0", "input"),
    conv("enc_conv1", "enc_conv0"),
    pool("pool1", "enc_conv1"),
    conv("enc_conv2", "pool1"),
    pool("pool2", "enc_conv2"),
    conv("enc_conv3", "pool2"),
    pool("pool3", "enc_conv3"),
    conv("enc_conv4", "pool3"),
    pool("pool4", "enc_conv4"),
    conv("enc_conv5a", "pool4"),
    conv("enc_conv5b", "enc_conv5a"),
    upsample("up4", "enc_conv5b"),
    concat("concat4", "up4", "pool3"),
    conv("dec_conv4a", "concat4"),
    conv("dec_conv4b", "dec_conv4a"),
    upsample("up3", "dec_conv4b"),
    concat("concat3", "up3", "pool2"),
    conv("dec_conv3a", "concat3"),
    conv("dec_conv3b", "dec_conv3a"),
    upsample("up2", "dec_conv3b"),
    concat("concat2", "up2", "pool1"),
    conv("dec_conv2a", "concat2"),
    conv("dec_conv2b", "dec_conv2a"),
    upsample("up1", "dec_conv2b"),
    concat("concat1", "up1", "input"),
    conv("dec_conv1a", "concat1"),
    conv("dec_conv1b", "dec_conv1a"),
    conv("dec_conv0", "dec_conv1b")
  ]
};
var OIDN_UNET_LARGE_SPEC = {
  schemaVersion: 1,
  id: "oidn-unet-large-v1",
  family: "oidn-unet-large",
  input: "input",
  output: "dec_conv1c",
  receptiveField: 202,
  nodes: [
    conv("enc_conv1a", "input"),
    conv("enc_conv1b", "enc_conv1a"),
    pool("pool1", "enc_conv1b"),
    conv("enc_conv2a", "pool1"),
    conv("enc_conv2b", "enc_conv2a"),
    pool("pool2", "enc_conv2b"),
    conv("enc_conv3a", "pool2"),
    conv("enc_conv3b", "enc_conv3a"),
    pool("pool3", "enc_conv3b"),
    conv("enc_conv4a", "pool3"),
    conv("enc_conv4b", "enc_conv4a"),
    pool("pool4", "enc_conv4b"),
    conv("enc_conv5a", "pool4"),
    conv("enc_conv5b", "enc_conv5a"),
    upsample("up4", "enc_conv5b"),
    concat("concat4", "up4", "pool3"),
    conv("dec_conv4a", "concat4"),
    conv("dec_conv4b", "dec_conv4a"),
    upsample("up3", "dec_conv4b"),
    concat("concat3", "up3", "pool2"),
    conv("dec_conv3a", "concat3"),
    conv("dec_conv3b", "dec_conv3a"),
    upsample("up2", "dec_conv3b"),
    concat("concat2", "up2", "pool1"),
    conv("dec_conv2a", "concat2"),
    conv("dec_conv2b", "dec_conv2a"),
    upsample("up1", "dec_conv2b"),
    concat("concat1", "up1", "input"),
    conv("dec_conv1a", "concat1"),
    conv("dec_conv1b", "dec_conv1a"),
    conv("dec_conv1c", "dec_conv1b")
  ]
};
var BUILTIN_MODEL_SPECS = [
  OIDN_UNET_SMALL_SPEC,
  OIDN_UNET_LARGE_SPEC
];
function expectedTensorNames(spec) {
  const names = /* @__PURE__ */ new Set();
  for (const node of spec.nodes) {
    if (node.op === "conv2d") {
      names.add(node.weight);
      names.add(node.bias);
    }
  }
  return names;
}
function tensorByteSize(tensor) {
  return tensor.desc.getByteSize();
}
function describeNames(names) {
  return [...names].sort().join(", ");
}
function detectUNetModelSpec(tensors, specs = BUILTIN_MODEL_SPECS) {
  const matches = specs.filter((spec) => {
    const expected = expectedTensorNames(spec);
    if ([...expected].some((name) => !tensors.has(name)))
      return false;
    return spec.allowAdditionalTensors === true || [...tensors.keys()].every((name) => expected.has(name));
  });
  if (matches.length === 1)
    return matches[0];
  if (matches.length > 1) {
    throw new Error(`Ambiguous OIDN model topology: ${matches.map((spec) => spec.id).join(", ")}`);
  }
  throw new Error(`Unsupported OIDN model topology. TZA tensors: ${describeNames([...tensors.keys()])}`);
}
function requireTensor(tensors, name, modelId) {
  const tensor = tensors.get(name);
  if (!tensor) {
    throw new Error(`Model ${modelId} is missing tensor ${name}`);
  }
  if (tensor.data.byteLength !== tensorByteSize(tensor)) {
    throw new Error(`Tensor ${name} has ${tensor.data.byteLength} bytes, expected ${tensorByteSize(tensor)}`);
  }
  return tensor;
}
function validateUNetModel(tensors, spec = detectUNetModelSpec(tensors)) {
  if (spec.schemaVersion !== 1) {
    throw new Error(`Unsupported model descriptor schema ${spec.schemaVersion}`);
  }
  const expected = expectedTensorNames(spec);
  if (!spec.allowAdditionalTensors) {
    const additional = [...tensors.keys()].filter((name) => !expected.has(name));
    if (additional.length > 0) {
      throw new Error(`Model ${spec.id} has unexpected tensors: ${describeNames(additional)}`);
    }
  }
  const channelsByValue = /* @__PURE__ */ new Map();
  const convTensors = /* @__PURE__ */ new Map();
  const convChannels = /* @__PURE__ */ new Map();
  const producedValues = /* @__PURE__ */ new Set([spec.input]);
  let inputChannels;
  let commonDataType;
  const getChannels = (value, nodeId) => {
    const channels = channelsByValue.get(value);
    if (channels === void 0) {
      throw new Error(`Model ${spec.id} node ${nodeId} reads unknown or forward value ${value}`);
    }
    return channels;
  };
  for (const node of spec.nodes) {
    if (producedValues.has(node.id)) {
      throw new Error(`Model ${spec.id} produces duplicate value ${node.id}`);
    }
    if (node.op === "conv2d") {
      const weight = requireTensor(tensors, node.weight, spec.id);
      const bias = requireTensor(tensors, node.bias, spec.id);
      const dims = weight.desc.dims;
      if (weight.desc.layout !== "oihw" || dims.length !== 4) {
        throw new Error(`Tensor ${node.weight} must use OIHW layout`);
      }
      if (dims[2] !== 3 || dims[3] !== 3) {
        throw new Error(`Tensor ${node.weight} must use a 3x3 kernel`);
      }
      if (bias.desc.layout !== "x" || bias.desc.dims.length !== 1) {
        throw new Error(`Tensor ${node.bias} must be a one-dimensional bias`);
      }
      if (bias.desc.dims[0] !== dims[0]) {
        throw new Error(`Tensor ${node.bias} has ${bias.desc.dims[0]} channels, expected ${dims[0]}`);
      }
      if (weight.desc.dataType !== bias.desc.dataType) {
        throw new Error(`Weight and bias dtype differ for ${node.id}`);
      }
      if (commonDataType && commonDataType !== weight.desc.dataType) {
        throw new Error(`Mixed tensor dtypes are not supported by model ${spec.id}`);
      }
      commonDataType = weight.desc.dataType;
      if (node.input === spec.input && inputChannels === void 0) {
        inputChannels = dims[1];
        channelsByValue.set(spec.input, inputChannels);
      }
      const actualInputChannels = getChannels(node.input, node.id);
      if (actualInputChannels !== dims[1]) {
        throw new Error(`Tensor ${node.weight} expects ${dims[1]} input channels, but ${node.input} provides ${actualInputChannels}`);
      }
      channelsByValue.set(node.id, dims[0]);
      convTensors.set(node.id, {
        weight,
        bias,
        inputChannels: dims[1],
        outputChannels: dims[0],
        kernelHeight: dims[2],
        kernelWidth: dims[3]
      });
      convChannels.set(node.id, {
        inputChannels: dims[1],
        outputChannels: dims[0]
      });
    } else if (node.op === "concat") {
      if (node.inputs.length < 2) {
        throw new Error(`Concat ${node.id} requires at least two inputs`);
      }
      const channels = node.inputs.reduce((sum, value) => sum + getChannels(value, node.id), 0);
      channelsByValue.set(node.id, channels);
    } else {
      channelsByValue.set(node.id, getChannels(node.input, node.id));
    }
    producedValues.add(node.id);
  }
  if (inputChannels === void 0 || commonDataType === void 0) {
    throw new Error(`Model ${spec.id} has no convolution reading its input`);
  }
  const outputChannels = channelsByValue.get(spec.output);
  if (outputChannels === void 0) {
    throw new Error(`Model ${spec.id} output ${spec.output} is not produced`);
  }
  if (outputChannels !== 3) {
    throw new Error(`Model ${spec.id} must produce 3 channels, got ${outputChannels}`);
  }
  return {
    spec,
    inputChannels,
    outputChannels,
    tensorDataType: commonDataType,
    channelsByValue,
    convChannels,
    convTensors
  };
}

// node_modules/oidn-webgpu/lib/graphOptimizer.js
function nodeInputs(node) {
  return node.op === "concat" ? node.inputs : [node.input];
}
function buildConsumers(spec) {
  const consumers = /* @__PURE__ */ new Map();
  for (const node of spec.nodes) {
    for (const input of nodeInputs(node)) {
      const list = consumers.get(input) ?? [];
      list.push(node);
      consumers.set(input, list);
    }
  }
  return consumers;
}
function onlyConsumer(consumers, value, op) {
  const list = consumers.get(value);
  if (list === void 0 || list.length !== 1 || list[0].op !== op)
    return void 0;
  return list[0];
}
function optimizeModelGraph(validated, options = {}) {
  const spec = validated.spec;
  const consumers = buildConsumers(spec);
  const nodesById = new Map(spec.nodes.map((node) => [node.id, node]));
  const eliminated = /* @__PURE__ */ new Set();
  const fusedAt = /* @__PURE__ */ new Map();
  let convPool = 0;
  let upsampleConcatConv = 0;
  if (options.fuseConvPool !== false) {
    for (const node of spec.nodes) {
      if (node.op !== "conv2d" || node.activation !== "relu")
        continue;
      const pool2 = onlyConsumer(consumers, node.id, "maxPool2d");
      if (!pool2 || pool2.op !== "maxPool2d" || pool2.size !== 2 || pool2.stride !== 2)
        continue;
      eliminated.add(node.id);
      fusedAt.set(pool2.id, {
        op: "fusedConvReluMaxPool2d",
        id: pool2.id,
        input: node.input,
        conv: node,
        pool: pool2
      });
      convPool++;
    }
  }
  if (options.fuseUpsampleConcatConv !== false) {
    for (const node of spec.nodes) {
      if (node.op !== "conv2d")
        continue;
      const concat2 = nodesById.get(node.input);
      if (concat2?.op !== "concat" || concat2.inputs.length !== 2)
        continue;
      if (onlyConsumer(consumers, concat2.id, "conv2d")?.id !== node.id)
        continue;
      const firstInputChannels = validated.channelsByValue.get(concat2.inputs[0]);
      if (firstInputChannels === void 0 || firstInputChannels % 4 !== 0) {
        continue;
      }
      const inputs = concat2.inputs.map((value) => {
        const candidate = nodesById.get(value);
        if (candidate?.op === "upsample2d" && candidate.scale === 2 && candidate.mode === "nearest" && onlyConsumer(consumers, candidate.id, "concat")?.id === concat2.id) {
          return { value: candidate.input, upsample: candidate };
        }
        return { value };
      });
      const upsampleCount = inputs.filter((input) => input.upsample).length;
      if (upsampleCount !== 1)
        continue;
      eliminated.add(concat2.id);
      for (const value of concat2.inputs) {
        const candidate = nodesById.get(value);
        if (candidate?.op === "upsample2d")
          eliminated.add(candidate.id);
      }
      fusedAt.set(node.id, {
        op: "fusedUpsampleConcatConv2d",
        id: node.id,
        inputs,
        conv: node
      });
      upsampleConcatConv++;
    }
  }
  const nodes = [];
  for (const node of spec.nodes) {
    const fused = fusedAt.get(node.id);
    if (fused) {
      nodes.push(fused);
    } else if (!eliminated.has(node.id)) {
      nodes.push(node);
    }
  }
  return {
    spec,
    nodes,
    fusions: { convPool, upsampleConcatConv }
  };
}
function executableInputs(node) {
  if (node.op === "concat")
    return node.inputs;
  if (node.op === "fusedUpsampleConcatConv2d") {
    return node.inputs.map((input) => input.value);
  }
  return [node.input];
}
function sameSpatialShape(left, right) {
  return left.width === right.width && left.height === right.height;
}
function planModelExecution(validated, width, height, options) {
  if (!Number.isInteger(width) || width <= 0 || !Number.isInteger(height) || height <= 0) {
    throw new Error(`Invalid model input size ${width}x${height}`);
  }
  const graph = optimizeModelGraph(validated, options);
  const inputShape = { width, height, channels: validated.inputChannels };
  const valueShapes = /* @__PURE__ */ new Map([
    [validated.spec.input, inputShape]
  ]);
  const outputShapes = [];
  const shapeOf = (value, nodeId) => {
    const shape = valueShapes.get(value);
    if (!shape)
      throw new Error(`Planned node ${nodeId} reads missing value ${value}`);
    return shape;
  };
  for (const node of graph.nodes) {
    let outputShape;
    if (node.op === "conv2d") {
      const input = shapeOf(node.input, node.id);
      outputShape = {
        width: input.width,
        height: input.height,
        channels: validated.convChannels.get(node.id).outputChannels
      };
    } else if (node.op === "maxPool2d") {
      const input = shapeOf(node.input, node.id);
      outputShape = {
        width: Math.ceil(input.width / 2),
        height: Math.ceil(input.height / 2),
        channels: input.channels
      };
    } else if (node.op === "upsample2d") {
      const input = shapeOf(node.input, node.id);
      outputShape = {
        width: input.width * 2,
        height: input.height * 2,
        channels: input.channels
      };
    } else if (node.op === "concat") {
      const inputs = node.inputs.map((value) => shapeOf(value, node.id));
      if (inputs.some((shape) => !sameSpatialShape(shape, inputs[0]))) {
        throw new Error(`Concat ${node.id} has mismatched spatial shapes`);
      }
      outputShape = {
        width: inputs[0].width,
        height: inputs[0].height,
        channels: inputs.reduce((sum, shape) => sum + shape.channels, 0)
      };
    } else if (node.op === "fusedConvReluMaxPool2d") {
      const input = shapeOf(node.input, node.id);
      outputShape = {
        width: Math.ceil(input.width / 2),
        height: Math.ceil(input.height / 2),
        channels: validated.convChannels.get(node.conv.id).outputChannels
      };
    } else {
      const inputs = node.inputs.map((input) => {
        const source = shapeOf(input.value, node.id);
        return input.upsample ? { ...source, width: source.width * 2, height: source.height * 2 } : source;
      });
      if (inputs.some((shape) => !sameSpatialShape(shape, inputs[0]))) {
        throw new Error(`Fused decoder ${node.id} has mismatched spatial shapes`);
      }
      outputShape = {
        width: inputs[0].width,
        height: inputs[0].height,
        channels: validated.convChannels.get(node.conv.id).outputChannels
      };
    }
    valueShapes.set(node.id, outputShape);
    outputShapes.push(outputShape);
  }
  const lastUses = /* @__PURE__ */ new Map();
  graph.nodes.forEach((node, index) => {
    for (const input of executableInputs(node))
      lastUses.set(input, index);
  });
  lastUses.set(validated.spec.output, graph.nodes.length);
  const plannedNodes = graph.nodes.map((node, index) => ({
    node,
    outputShape: outputShapes[index],
    lastUse: lastUses.get(node.id) ?? index
  }));
  return { ...graph, inputShape, valueShapes, plannedNodes };
}

// node_modules/oidn-webgpu/lib/gpuTypes.js
var BufferUsage = {
  MAP_READ: 1,
  MAP_WRITE: 2,
  COPY_SRC: 4,
  COPY_DST: 8,
  INDEX: 16,
  VERTEX: 32,
  UNIFORM: 64,
  STORAGE: 128,
  INDIRECT: 256,
  QUERY_RESOLVE: 512
};
var MapMode = {
  READ: 1,
  WRITE: 2
};

// node_modules/oidn-webgpu/lib/finalRgbShader.js
var WORKGROUP_SIZE2 = 8;
var PATCH_SIZE = WORKGROUP_SIZE2 + 2;
var KERNEL_ELEMENTS = 3 * 3;
function sharedMemoryBytes(precision, inputBlocks, cacheWeights = false) {
  const bytesPerScalar = precision === "fp16" ? 2 : 4;
  const inputVec4Count = PATCH_SIZE * PATCH_SIZE * inputBlocks;
  const weightVec4Count = cacheWeights ? KERNEL_ELEMENTS * inputBlocks * 4 : 0;
  const vec4Count = inputVec4Count + weightVec4Count;
  return vec4Count * 4 * bytesPerScalar;
}
function storageVecType(precision) {
  return precision === "fp16" ? "vec4<f16>" : "vec4<f32>";
}
function shaderPreamble(precision) {
  return precision === "fp16" ? "enable f16;\n" : "";
}
function accumulationCode(precision, inputExpression, weightExpression) {
  const weight = (lane) => `${weightExpression}[weightBase + ${lane}u]`;
  if (precision === "fp16") {
    return (
      /* wgsl */
      `
        let inputValue = vec4<f16>(${inputExpression});
        var partial = vec4<f16>(0.0h);
        partial = fma(${weight(0)}, vec4<f16>(inputValue.x), partial);
        partial = fma(${weight(1)}, vec4<f16>(inputValue.y), partial);
        partial = fma(${weight(2)}, vec4<f16>(inputValue.z), partial);
        partial = fma(${weight(3)}, vec4<f16>(inputValue.w), partial);
        acc += vec4<f32>(partial);
`
    );
  }
  return (
    /* wgsl */
    `
        let inputValue = vec4<f32>(${inputExpression});
        acc = fma(vec4<f32>(${weight(0)}), vec4<f32>(inputValue.x), acc);
        acc = fma(vec4<f32>(${weight(1)}), vec4<f32>(inputValue.y), acc);
        acc = fma(vec4<f32>(${weight(2)}), vec4<f32>(inputValue.z), acc);
        acc = fma(vec4<f32>(${weight(3)}), vec4<f32>(inputValue.w), acc);
`
  );
}
function createFinalRgbShader(precision, activation2, inputBlocks, cacheWeights = false) {
  if (!Number.isInteger(inputBlocks) || inputBlocks < 1) {
    throw new Error(`Final RGB shader requires positive input blocks, got ${inputBlocks}`);
  }
  const inputType = storageVecType(precision);
  const outputType = "vec4<f32>";
  const inputTileValues = PATCH_SIZE * PATCH_SIZE * inputBlocks;
  const weightTileValues = KERNEL_ELEMENTS * inputBlocks * 4;
  const stored = activation2 === "relu" ? "max(acc, vec4<f32>(0.0))" : "acc";
  const accumulation = accumulationCode(precision, "inputTile[patchBase + inputBlock]", cacheWeights ? "weightTile" : "weights");
  return (
    /* wgsl */
    `${shaderPreamble(precision)}
struct Params {
  inputWidth: u32,
  inputHeight: u32,
  outputWidth: u32,
  outputHeight: u32,
  inputBlocks: u32,
  outputBlocks: u32,
}

@group(0) @binding(0) var<storage, read> inputData: array<${inputType}>;
@group(0) @binding(1) var<storage, read> weights: array<${inputType}>;
@group(0) @binding(2) var<storage, read> bias: array<vec4<f32>>;
@group(0) @binding(3) var<storage, read_write> outputData: array<${outputType}>;
@group(0) @binding(4) var<uniform> params: Params;

var<workgroup> inputTile: array<${inputType}, ${inputTileValues}>;
${cacheWeights ? `var<workgroup> weightTile: array<${inputType}, ${weightTileValues}>;` : ""}

@compute @workgroup_size(${WORKGROUP_SIZE2}, ${WORKGROUP_SIZE2}, 1)
fn main(
  @builtin(local_invocation_id) localId: vec3<u32>,
  @builtin(global_invocation_id) gid: vec3<u32>,
  @builtin(workgroup_id) workgroupId: vec3<u32>
) {
  let localLinear = localId.y * ${WORKGROUP_SIZE2}u + localId.x;
  for (
    var loadIndex = localLinear;
    loadIndex < ${inputTileValues}u;
    loadIndex += ${WORKGROUP_SIZE2 * WORKGROUP_SIZE2}u
  ) {
    let tilePixel = loadIndex / ${inputBlocks}u;
    let inputBlock = loadIndex % ${inputBlocks}u;
    let tileX = tilePixel % ${PATCH_SIZE}u;
    let tileY = tilePixel / ${PATCH_SIZE}u;
    let inputX = i32(workgroupId.x * ${WORKGROUP_SIZE2}u + tileX) - 1;
    let inputY = i32(workgroupId.y * ${WORKGROUP_SIZE2}u + tileY) - 1;
    var value = ${inputType}(0.0);
    if (
      inputX >= 0 && inputX < i32(params.inputWidth) &&
      inputY >= 0 && inputY < i32(params.inputHeight)
    ) {
      let inputIndex =
        (u32(inputY) * params.inputWidth + u32(inputX)) *
        ${inputBlocks}u + inputBlock;
      value = inputData[inputIndex];
    }
    inputTile[loadIndex] = value;
  }

${cacheWeights ? `  for (
    var loadIndex = localLinear;
    loadIndex < ${weightTileValues}u;
    loadIndex += ${WORKGROUP_SIZE2 * WORKGROUP_SIZE2}u
  ) {
    weightTile[loadIndex] = weights[loadIndex];
  }

` : ""}  // Out-of-range invocations must reach this barrier before returning.
  workgroupBarrier();

  let outputInBounds =
    gid.x < params.outputWidth &&
    gid.y < params.outputHeight &&
    gid.z < params.outputBlocks;
  if (!outputInBounds) {
    return;
  }

  var acc = bias[gid.z];
  for (var ky = 0u; ky < 3u; ky++) {
    let inputY = i32(gid.y) + i32(ky) - 1;
    if (inputY < 0 || inputY >= i32(params.inputHeight)) {
      continue;
    }
    for (var kx = 0u; kx < 3u; kx++) {
      let inputX = i32(gid.x) + i32(kx) - 1;
      if (inputX < 0 || inputX >= i32(params.inputWidth)) {
        continue;
      }
      let patchBase =
        ((localId.y + ky) * ${PATCH_SIZE}u + localId.x + kx) *
        ${inputBlocks}u;
      for (var inputBlock = 0u; inputBlock < ${inputBlocks}u; inputBlock++) {
        let weightBase =
          ((ky * 3u + kx) * ${inputBlocks}u + inputBlock) * 4u;
        ${accumulation}
      }
    }
  }

  let outputIndex =
    (gid.y * params.outputWidth + gid.x) * ${1}u + gid.z;
  outputData[outputIndex] = ${stored};
}
`
  );
}

// node_modules/oidn-webgpu/lib/resourceTracker.js
var OIDNResourceTracker = class {
  _stats = /* @__PURE__ */ new Map();
  track(kind, resource) {
    let stats = this._stats.get(kind);
    if (!stats) {
      stats = {
        created: 0,
        destroyed: 0,
        live: 0,
        peakLive: 0,
        resources: /* @__PURE__ */ new Set()
      };
      this._stats.set(kind, stats);
    }
    if (stats.resources.has(resource))
      return resource;
    stats.resources.add(resource);
    stats.created++;
    stats.live++;
    stats.peakLive = Math.max(stats.peakLive, stats.live);
    return resource;
  }
  release(kind, resource, destroy) {
    if (!resource)
      return false;
    const stats = this._stats.get(kind);
    if (!stats?.resources.delete(resource))
      return false;
    try {
      destroy();
    } finally {
      stats.destroyed++;
      stats.live--;
    }
    return true;
  }
  snapshot(pending = 0) {
    let live = 0;
    let created = 0;
    let destroyed = 0;
    let peakLive = 0;
    const byKind = {};
    for (const [kind, stats] of this._stats) {
      const entry = {
        created: stats.created,
        destroyed: stats.destroyed,
        live: stats.live,
        peakLive: stats.peakLive
      };
      byKind[kind] = entry;
      live += entry.live;
      created += entry.created;
      destroyed += entry.destroyed;
      peakLive += entry.peakLive;
    }
    return { live, created, destroyed, peakLive, pending, byKind };
  }
};

// node_modules/oidn-webgpu/lib/nativeUNetCore.js
var pipelineCachesByDevice = /* @__PURE__ */ new WeakMap();
function sharedPipelineCache(device) {
  let cache = pipelineCachesByDevice.get(device);
  if (!cache) {
    cache = /* @__PURE__ */ new Map();
    pipelineCachesByDevice.set(device, cache);
  }
  return cache;
}
var WORKGROUP_SIZE3 = 8;
var TILED_CONV_K_BLOCKS = 8;
var SPATIAL_CONV_WORKGROUP = 8;
var SPATIAL_CONV_PATCH = SPATIAL_CONV_WORKGROUP + 2;
function gemmTile(options) {
  const [workgroupX, workgroupY] = options.workgroupSize;
  return {
    workgroupX,
    workgroupY,
    rowsPerThread: options.rowsPerThread,
    tileM: workgroupY * options.rowsPerThread,
    tileNBlocks: workgroupX,
    // Keep the half partial accumulation grouping independent of tile tuning.
    tileKBlocks: TILED_CONV_K_BLOCKS
  };
}
function gemmSharedSizes(options) {
  const tile = gemmTile(options);
  const paddedInput = options.sharedLayout === "padded" || options.sharedLayout === "padded-input";
  const paddedWeights = options.sharedLayout === "padded" || options.sharedLayout === "padded-weights";
  return {
    input: tile.tileM * tile.tileKBlocks + (paddedInput ? tile.workgroupY : 0),
    weights: tile.tileKBlocks * tile.tileNBlocks * (paddedWeights ? 5 : 4)
  };
}
function gemmSharedInputIndex(index, options) {
  return options.sharedLayout === "padded" || options.sharedLayout === "padded-input" ? `(${index}) + (${index}) / ${options.rowsPerThread * TILED_CONV_K_BLOCKS}u` : index;
}
function gemmSharedWeightIndex(index, options) {
  return options.sharedLayout === "padded" || options.sharedLayout === "padded-weights" ? `(${index}) + (${index}) / 4u` : index;
}
function roundUp(value, alignment) {
  return Math.ceil(value / alignment) * alignment;
}
function blocksForChannels(channels) {
  return Math.ceil(channels / 4);
}
function activationByteSize(shape, bytesPerScalar) {
  return shape.width * shape.height * blocksForChannels(shape.channels) * 4 * bytesPerScalar;
}
var float16ToFloat32Lookup;
function halfBitsToNumber(bits) {
  const sign = bits & 32768 ? -1 : 1;
  const exponent = bits >>> 10 & 31;
  const fraction = bits & 1023;
  if (exponent === 0) {
    return sign * fraction * 2 ** -24;
  }
  if (exponent === 31) {
    return fraction === 0 ? sign * Infinity : NaN;
  }
  return sign * (1 + fraction / 1024) * 2 ** (exponent - 15);
}
var halfConversionView = new DataView(new ArrayBuffer(4));
function numberToHalfBits(value) {
  halfConversionView.setFloat32(0, value);
  const bits = halfConversionView.getUint32(0);
  const sign = bits >>> 16 & 32768;
  const exponent = bits >>> 23 & 255;
  const mantissa = bits & 8388607;
  if (exponent === 255) {
    return sign | 31744 | (mantissa ? 512 : 0);
  }
  const halfExponent = exponent - 127 + 15;
  if (halfExponent >= 31)
    return sign | 31744;
  if (halfExponent <= 0) {
    if (halfExponent < -10)
      return sign;
    const full = mantissa | 8388608;
    const shift = 14 - halfExponent;
    const half2 = full >>> shift;
    const remainder2 = full & (1 << shift) - 1;
    const midpoint = 1 << shift - 1;
    const rounded = remainder2 > midpoint || remainder2 === midpoint && half2 & 1 ? half2 + 1 : half2;
    return sign | rounded;
  }
  const half = halfExponent << 10 | mantissa >>> 13;
  const remainder = mantissa & 8191;
  return sign | (remainder > 4096 || remainder === 4096 && half & 1 ? half + 1 : half);
}
function halfLookup() {
  if (!float16ToFloat32Lookup) {
    float16ToFloat32Lookup = new Float32Array(1 << 16);
    for (let bits = 0; bits < float16ToFloat32Lookup.length; bits++) {
      float16ToFloat32Lookup[bits] = halfBitsToNumber(bits);
    }
  }
  return float16ToFloat32Lookup;
}
function tensorFloat32Values(tensor) {
  if (tensor.desc.dataType === "Float32") {
    return new Float32Array(tensor.data.buffer, tensor.data.byteOffset, tensor.data.byteLength / 4);
  }
  const bits = new Uint16Array(tensor.data.buffer, tensor.data.byteOffset, tensor.data.byteLength / 2);
  const values2 = new Float32Array(bits.length);
  if (bits.length < 4096) {
    for (let index = 0; index < bits.length; index++) {
      values2[index] = halfBitsToNumber(bits[index]);
    }
  } else {
    const lookup = halfLookup();
    for (let index = 0; index < bits.length; index++) {
      values2[index] = lookup[bits[index]];
    }
  }
  return values2;
}
function createMappedBuffer(device, label, data, usage) {
  const size = roundUp(data.byteLength, 4);
  const buffer2 = device.createBuffer({
    label,
    size,
    usage,
    mappedAtCreation: true
  });
  new Uint8Array(buffer2.getMappedRange()).set(data);
  buffer2.unmap();
  return buffer2;
}
function createUniformBuffer(device, label, values2) {
  const data = new Uint32Array(roundUp(values2.length, 4));
  data.set(values2);
  return createMappedBuffer(device, label, new Uint8Array(data.buffer, data.byteOffset, data.byteLength), BufferUsage.UNIFORM);
}
function packConvTensors(device, id, tensors, precision, weightLayout) {
  const inputBlocks = blocksForChannels(tensors.inputChannels);
  const outputBlocks = blocksForChannels(tensors.outputChannels);
  const packedWeightCount = outputBlocks * tensors.kernelHeight * tensors.kernelWidth * inputBlocks * 4 * 4;
  const canCopyHalfBits = precision === "fp16" && tensors.weight.desc.dataType === "Float16";
  const halfWeights = precision === "fp16" ? new Uint16Array(packedWeightCount) : void 0;
  const floatWeights = halfWeights ? void 0 : new Float32Array(packedWeightCount);
  const sourceHalfBits = canCopyHalfBits ? new Uint16Array(tensors.weight.data.buffer, tensors.weight.data.byteOffset, tensors.weight.data.byteLength / 2) : void 0;
  const sourceValues = sourceHalfBits ? void 0 : tensorFloat32Values(tensors.weight);
  for (let outputBlock = 0; outputBlock < outputBlocks; outputBlock++) {
    for (let y = 0; y < tensors.kernelHeight; y++) {
      for (let x = 0; x < tensors.kernelWidth; x++) {
        for (let inputBlock = 0; inputBlock < inputBlocks; inputBlock++) {
          for (let outputLane = 0; outputLane < 4; outputLane++) {
            const outputChannel = outputBlock * 4 + outputLane;
            for (let inputLane = 0; inputLane < 4; inputLane++) {
              const inputChannel = inputBlock * 4 + inputLane;
              const packedBlock = weightLayout === "k-major" ? (((y * tensors.kernelWidth + x) * inputBlocks + inputBlock) * outputBlocks + outputBlock) * 16 : (((outputBlock * tensors.kernelHeight + y) * tensors.kernelWidth + x) * inputBlocks + inputBlock) * 16;
              const packedIndex = packedBlock + inputLane * 4 + outputLane;
              if (outputChannel < tensors.outputChannels && inputChannel < tensors.inputChannels) {
                const sourceIndex = ((outputChannel * tensors.inputChannels + inputChannel) * tensors.kernelHeight + y) * tensors.kernelWidth + x;
                if (halfWeights) {
                  halfWeights[packedIndex] = sourceHalfBits ? sourceHalfBits[sourceIndex] : numberToHalfBits(sourceValues[sourceIndex]);
                } else {
                  floatWeights[packedIndex] = sourceValues[sourceIndex];
                }
              }
            }
          }
        }
      }
    }
  }
  const packedBias = new Float32Array(outputBlocks * 4);
  packedBias.set(tensorFloat32Values(tensors.bias));
  const weights = createMappedBuffer(device, `oidn/${id}/weights/${precision}/${weightLayout}`, halfWeights ? new Uint8Array(halfWeights.buffer) : new Uint8Array(floatWeights.buffer), BufferUsage.STORAGE);
  try {
    return {
      weights,
      weightLayout,
      bias: createMappedBuffer(device, `oidn/${id}/bias`, new Uint8Array(packedBias.buffer), BufferUsage.STORAGE)
    };
  } catch (error) {
    weights.destroy();
    throw error;
  }
}
function storageVecType2(precision) {
  return precision === "fp16" ? "vec4<f16>" : "vec4<f32>";
}
function shaderPreamble2(precision) {
  return precision === "fp16" ? "enable f16;\n" : "";
}
function storeExpression(expression, outputPrecision) {
  return outputPrecision === "fp16" ? `vec4<f16>(${expression})` : expression;
}
function activationExpression(expression, activation2) {
  return activation2 === "relu" ? `max(${expression}, vec4<f32>(0.0))` : expression;
}
function accumulationCode2(inputExpression, weightBase, precision) {
  if (precision === "fp32") {
    return (
      /* wgsl */
      `
let inputValue = vec4<f32>(${inputExpression});
let weightBase = ${weightBase};
acc = fma(vec4<f32>(weights[weightBase]), vec4<f32>(inputValue.x), acc);
acc = fma(vec4<f32>(weights[weightBase + 1u]), vec4<f32>(inputValue.y), acc);
acc = fma(vec4<f32>(weights[weightBase + 2u]), vec4<f32>(inputValue.z), acc);
acc = fma(vec4<f32>(weights[weightBase + 3u]), vec4<f32>(inputValue.w), acc);
`
    );
  }
  return (
    /* wgsl */
    `
let inputValue = vec4<f16>(${inputExpression});
let weightBase = ${weightBase};
var partial = vec4<f16>(0.0h);
partial = fma(weights[weightBase], vec4<f16>(inputValue.x), partial);
partial = fma(weights[weightBase + 1u], vec4<f16>(inputValue.y), partial);
partial = fma(weights[weightBase + 2u], vec4<f16>(inputValue.z), partial);
partial = fma(weights[weightBase + 3u], vec4<f16>(inputValue.w), partial);
acc += vec4<f32>(partial);
`
  );
}
function subgroupAccumulationCode(inputExpression, weightBase, precision) {
  const inputType = precision === "fp16" ? "vec4<f16>" : "vec4<f32>";
  const accumulator = precision === "fp16" ? `var partial = vec4<f16>(0.0h);
partial = fma(subgroupBroadcast(weights[weightBase], 0u), ${inputType}(inputValue.x), partial);
partial = fma(subgroupBroadcast(weights[weightBase + 1u], 0u), ${inputType}(inputValue.y), partial);
partial = fma(subgroupBroadcast(weights[weightBase + 2u], 0u), ${inputType}(inputValue.z), partial);
partial = fma(subgroupBroadcast(weights[weightBase + 3u], 0u), ${inputType}(inputValue.w), partial);
acc += vec4<f32>(partial);` : `acc = fma(subgroupBroadcast(weights[weightBase], 0u), vec4<f32>(inputValue.x), acc);
acc = fma(subgroupBroadcast(weights[weightBase + 1u], 0u), vec4<f32>(inputValue.y), acc);
acc = fma(subgroupBroadcast(weights[weightBase + 2u], 0u), vec4<f32>(inputValue.z), acc);
acc = fma(subgroupBroadcast(weights[weightBase + 3u], 0u), vec4<f32>(inputValue.w), acc);`;
  return (
    /* wgsl */
    `
let inputValue = ${inputType}(${inputExpression});
let weightBase = ${weightBase};
${accumulator}
`
  );
}
function gemmPackedLoad(precision, gemm, weights) {
  return precision === "fp16" && (gemm.loadMode === "packed-all" || weights && gemm.loadMode === "packed-weights");
}
function gemmLoadExpression(expression, packed) {
  return packed ? `bitcast<vec4<f16>>(${expression})` : expression;
}
function tiledAccumulationCode(precision, gemm) {
  const { rowsPerThread, tileNBlocks, tileKBlocks } = gemmTile(gemm);
  if (!gemm.unrollRows || gemm.accumulationOrder === "row-major") {
    return rolledAccumulationCode(precision, gemm);
  }
  const weightBase = `(tileK * ${tileNBlocks}u + localId.x) * ${gemm.sharedLayout === "padded" || gemm.sharedLayout === "padded-weights" ? 5 : 4}u`;
  const rows = Array.from({ length: rowsPerThread }, (_, row) => row);
  const type = storageVecType2(precision);
  return (
    /* wgsl */
    `
    ${precision === "fp16" ? rows.map((row) => `var partial${row} = vec4<f16>(0.0h);`).join("\n    ") : ""}
    for (var tileK = 0u; tileK < ${tileKBlocks}u; tileK++) {
      let weightBase = ${weightBase};
      let w0 = weightTile[weightBase];
      let w1 = weightTile[weightBase + 1u];
      let w2 = weightTile[weightBase + 2u];
      let w3 = weightTile[weightBase + 3u];
      ${rows.map((row) => {
      const index = gemmSharedInputIndex(`(localId.y * ${rowsPerThread}u + ${row}u) * ${tileKBlocks}u + tileK`, gemm);
      const target = precision === "fp16" ? `partial${row}` : `acc[${row}]`;
      return `let v${row} = inputTile[${index}];
      ` + ["x", "y", "z", "w"].map((lane, k) => `${target} = fma(w${k}, ${type}(v${row}.${lane}), ${target});`).join("\n      ");
    }).join("\n      ")}
    }
    ${precision === "fp16" ? rows.map((row) => `acc[${row}] += vec4<f32>(partial${row});`).join("\n    ") : ""}
`
  );
}
function rolledAccumulationCode(precision, gemm) {
  const { rowsPerThread, tileNBlocks, tileKBlocks } = gemmTile(gemm);
  const inputIndex = gemmSharedInputIndex(`tileSpatial * ${tileKBlocks}u + tileK`, gemm);
  const weightBase = `(tileK * ${tileNBlocks}u + localId.x) * ${gemm.sharedLayout === "padded" || gemm.sharedLayout === "padded-weights" ? 5 : 4}u`;
  if (gemm.accumulationOrder === "row-major") {
    const valueType = storageVecType2(precision);
    const target = precision === "fp16" ? "partial" : "acc[row]";
    return (
      /* wgsl */
      `
    for (var row = 0u; row < ${rowsPerThread}u; row++) {
      ${precision === "fp16" ? "var partial = vec4<f16>(0.0h);" : ""}
      let tileSpatial = localId.y * ${rowsPerThread}u + row;
      for (var tileK = 0u; tileK < ${tileKBlocks}u; tileK++) {
        let weightBase = ${weightBase};
        let inputValue = inputTile[${inputIndex}];
        ${target} = fma(weightTile[weightBase], ${valueType}(inputValue.x), ${target});
        ${target} = fma(weightTile[weightBase + 1u], ${valueType}(inputValue.y), ${target});
        ${target} = fma(weightTile[weightBase + 2u], ${valueType}(inputValue.z), ${target});
        ${target} = fma(weightTile[weightBase + 3u], ${valueType}(inputValue.w), ${target});
      }
      ${precision === "fp16" ? "acc[row] += vec4<f32>(partial);" : ""}
    }
`
    );
  }
  if (precision === "fp16") {
    return (
      /* wgsl */
      `
    var partial: array<vec4<f16>, ${rowsPerThread}>;
    for (var row = 0u; row < ${rowsPerThread}u; row++) {
      partial[row] = vec4<f16>(0.0h);
    }
    for (var tileK = 0u; tileK < ${tileKBlocks}u; tileK++) {
      let weightBase =
        ${weightBase};
      for (var row = 0u; row < ${rowsPerThread}u; row++) {
        let tileSpatial =
          localId.y * ${rowsPerThread}u + row;
        let inputValue =
          inputTile[${inputIndex}];
        partial[row] = fma(
          weightTile[weightBase],
          vec4<f16>(inputValue.x),
          partial[row]
        );
        partial[row] = fma(
          weightTile[weightBase + 1u],
          vec4<f16>(inputValue.y),
          partial[row]
        );
        partial[row] = fma(
          weightTile[weightBase + 2u],
          vec4<f16>(inputValue.z),
          partial[row]
        );
        partial[row] = fma(
          weightTile[weightBase + 3u],
          vec4<f16>(inputValue.w),
          partial[row]
        );
      }
    }
    for (var row = 0u; row < ${rowsPerThread}u; row++) {
      acc[row] += vec4<f32>(partial[row]);
    }
`
    );
  }
  return (
    /* wgsl */
    `
    for (var tileK = 0u; tileK < ${tileKBlocks}u; tileK++) {
      let weightBase =
        ${weightBase};
      for (var row = 0u; row < ${rowsPerThread}u; row++) {
        let tileSpatial =
          localId.y * ${rowsPerThread}u + row;
        let inputValue =
          inputTile[${inputIndex}];
        acc[row] = fma(
          weightTile[weightBase],
          vec4<f32>(inputValue.x),
          acc[row]
        );
        acc[row] = fma(
          weightTile[weightBase + 1u],
          vec4<f32>(inputValue.y),
          acc[row]
        );
        acc[row] = fma(
          weightTile[weightBase + 2u],
          vec4<f32>(inputValue.z),
          acc[row]
        );
        acc[row] = fma(
          weightTile[weightBase + 3u],
          vec4<f32>(inputValue.w),
          acc[row]
        );
      }
    }
`
  );
}
function createConvShader(precision, outputPrecision, activation2, inputBlocks, outputBlocks) {
  const inputType = storageVecType2(precision);
  const weightType = storageVecType2(precision);
  const outputType = storageVecType2(outputPrecision);
  const stored = storeExpression(activationExpression("acc", activation2), outputPrecision);
  return (
    /* wgsl */
    `${shaderPreamble2(precision)}
struct Params {
  inputWidth: u32,
  inputHeight: u32,
  outputWidth: u32,
  outputHeight: u32,
  inputBlocks: u32,
  outputBlocks: u32,
}

@group(0) @binding(0) var<storage, read> inputData: array<${inputType}>;
@group(0) @binding(1) var<storage, read> weights: array<${weightType}>;
@group(0) @binding(2) var<storage, read> bias: array<vec4<f32>>;
@group(0) @binding(3) var<storage, read_write> outputData: array<${outputType}>;
@group(0) @binding(4) var<uniform> params: Params;

@compute @workgroup_size(${WORKGROUP_SIZE3}, ${WORKGROUP_SIZE3}, 1)
fn main(@builtin(global_invocation_id) gid: vec3<u32>) {
  if (gid.x >= params.outputWidth || gid.y >= params.outputHeight || gid.z >= ${outputBlocks}u) {
    return;
  }
  var acc = bias[gid.z];
  for (var ky = 0u; ky < 3u; ky++) {
    let inputY = i32(gid.y) + i32(ky) - 1;
    if (inputY < 0 || inputY >= i32(params.inputHeight)) { continue; }
    for (var kx = 0u; kx < 3u; kx++) {
      let inputX = i32(gid.x) + i32(kx) - 1;
      if (inputX < 0 || inputX >= i32(params.inputWidth)) { continue; }
      let pixelBase = (u32(inputY) * params.inputWidth + u32(inputX)) * ${inputBlocks}u;
      for (var inputBlock = 0u; inputBlock < ${inputBlocks}u; inputBlock++) {
        ${accumulationCode2("inputData[pixelBase + inputBlock]", `((((gid.z * 3u + ky) * 3u + kx) * ${inputBlocks}u + inputBlock) * 4u)`, precision)}
      }
    }
  }
  let outputIndex = (gid.y * params.outputWidth + gid.x) * ${outputBlocks}u + gid.z;
  outputData[outputIndex] = ${stored};
}
`
  );
}
function createSubgroupConvShader(precision, outputPrecision, activation2, inputBlocks, outputBlocks) {
  const inputType = storageVecType2(precision);
  const weightType = storageVecType2(precision);
  const outputType = storageVecType2(outputPrecision);
  const stored = storeExpression(activationExpression("acc", activation2), outputPrecision);
  return (
    /* wgsl */
    `${shaderPreamble2(precision)}
enable subgroups;
struct Params {
  inputWidth: u32,
  inputHeight: u32,
  outputWidth: u32,
  outputHeight: u32,
  inputBlocks: u32,
  outputBlocks: u32,
}
@group(0) @binding(0) var<storage, read> inputData: array<${inputType}>;
@group(0) @binding(1) var<storage, read> weights: array<${weightType}>;
@group(0) @binding(2) var<storage, read> bias: array<vec4<f32>>;
@group(0) @binding(3) var<storage, read_write> outputData: array<${outputType}>;
@group(0) @binding(4) var<uniform> params: Params;

@compute @workgroup_size(${WORKGROUP_SIZE3}, ${WORKGROUP_SIZE3}, 1)
fn main(@builtin(global_invocation_id) gid: vec3<u32>) {
  let outputInBounds =
    gid.x < params.outputWidth && gid.y < params.outputHeight;
  var acc = bias[gid.z];
  for (var ky = 0u; ky < 3u; ky++) {
    let inputY = i32(gid.y) + i32(ky) - 1;
    let clampedY = u32(clamp(inputY, 0, i32(params.inputHeight) - 1));
    for (var kx = 0u; kx < 3u; kx++) {
      let inputX = i32(gid.x) + i32(kx) - 1;
      let clampedX = u32(clamp(inputX, 0, i32(params.inputWidth) - 1));
      let inputInBounds =
        outputInBounds && inputX >= 0 && inputY >= 0 &&
        inputX < i32(params.inputWidth) && inputY < i32(params.inputHeight);
      let pixelBase =
        (clampedY * params.inputWidth + clampedX) * ${inputBlocks}u;
      for (var inputBlock = 0u; inputBlock < ${inputBlocks}u; inputBlock++) {
        ${subgroupAccumulationCode(`select(${inputType}(0.0), inputData[pixelBase + inputBlock], inputInBounds)`, `((((gid.z * 3u + ky) * 3u + kx) * ${inputBlocks}u + inputBlock) * 4u)`, precision)}
      }
    }
  }
  if (outputInBounds) {
    let outputIndex =
      (gid.y * params.outputWidth + gid.x) * ${outputBlocks}u + gid.z;
    outputData[outputIndex] = ${stored};
  }
}
`
  );
}
function createSpatialConvShader(precision, outputPrecision, activation2, inputBlocks, outputBlocks) {
  const inputType = storageVecType2(precision);
  const outputType = storageVecType2(outputPrecision);
  const stored = storeExpression(activationExpression("acc", activation2), outputPrecision);
  const patchValues = SPATIAL_CONV_PATCH * SPATIAL_CONV_PATCH * inputBlocks;
  const workgroupThreads = SPATIAL_CONV_WORKGROUP * SPATIAL_CONV_WORKGROUP;
  return (
    /* wgsl */
    `${shaderPreamble2(precision)}
struct Params {
  inputWidth: u32,
  inputHeight: u32,
  outputWidth: u32,
  outputHeight: u32,
  inputBlocks: u32,
  outputBlocks: u32,
}
@group(0) @binding(0) var<storage, read> inputData: array<${inputType}>;
@group(0) @binding(1) var<storage, read> weights: array<${inputType}>;
@group(0) @binding(2) var<storage, read> bias: array<vec4<f32>>;
@group(0) @binding(3) var<storage, read_write> outputData: array<${outputType}>;
@group(0) @binding(4) var<uniform> params: Params;

var<workgroup> inputPatch: array<${inputType}, ${patchValues}>;

@compute @workgroup_size(${SPATIAL_CONV_WORKGROUP}, ${SPATIAL_CONV_WORKGROUP}, 1)
fn main(
  @builtin(local_invocation_id) localId: vec3<u32>,
  @builtin(workgroup_id) workgroupId: vec3<u32>
) {
  let localLinear =
    localId.y * ${SPATIAL_CONV_WORKGROUP}u + localId.x;
  for (
    var loadIndex = localLinear;
    loadIndex < ${patchValues}u;
    loadIndex += ${workgroupThreads}u
  ) {
    let patchPixel = loadIndex / ${inputBlocks}u;
    let inputBlock = loadIndex % ${inputBlocks}u;
    let patchX = patchPixel % ${SPATIAL_CONV_PATCH}u;
    let patchY = patchPixel / ${SPATIAL_CONV_PATCH}u;
    let inputX =
      i32(workgroupId.x * ${SPATIAL_CONV_WORKGROUP}u + patchX) - 1;
    let inputY =
      i32(workgroupId.y * ${SPATIAL_CONV_WORKGROUP}u + patchY) - 1;
    var value = ${inputType}(0.0);
    if (
      inputX >= 0 && inputX < i32(params.inputWidth) &&
      inputY >= 0 && inputY < i32(params.inputHeight)
    ) {
      let inputIndex =
        (u32(inputY) * params.inputWidth + u32(inputX)) *
        ${inputBlocks}u + inputBlock;
      value = inputData[inputIndex];
    }
    inputPatch[loadIndex] = value;
  }
  workgroupBarrier();

  let outputX =
    workgroupId.x * ${SPATIAL_CONV_WORKGROUP}u + localId.x;
  let outputY =
    workgroupId.y * ${SPATIAL_CONV_WORKGROUP}u + localId.y;
  let outputBlock = workgroupId.z;
  if (
    outputX >= params.outputWidth || outputY >= params.outputHeight ||
    outputBlock >= ${outputBlocks}u
  ) {
    return;
  }

  var acc = bias[outputBlock];
  for (var ky = 0u; ky < 3u; ky++) {
    for (var kx = 0u; kx < 3u; kx++) {
      let patchBase =
        ((localId.y + ky) * ${SPATIAL_CONV_PATCH}u + localId.x + kx) *
        ${inputBlocks}u;
      for (var inputBlock = 0u; inputBlock < ${inputBlocks}u; inputBlock++) {
        ${accumulationCode2("inputPatch[patchBase + inputBlock]", `((((outputBlock * 3u + ky) * 3u + kx) * ${inputBlocks}u + inputBlock) * 4u)`, precision)}
      }
    }
  }
  let outputIndex =
    (outputY * params.outputWidth + outputX) * ${outputBlocks}u + outputBlock;
  outputData[outputIndex] = ${stored};
}
`
  );
}
function tiledAddressCacheCode(inputBlocks, decoder, gemm, sources) {
  const { workgroupX, workgroupY, tileM, tileKBlocks } = gemmTile(gemm);
  const width = decoder ? "params.outputWidth" : "params.inputWidth";
  const height = decoder ? "params.outputHeight" : "params.inputHeight";
  const baseOffset = gemm.addressMode === "base-offset";
  const baseAssignments = sources ? sources.blocks.map((blocks, source) => `cachedBase${source}[load] = (${source === sources.upsampled ? "y / 2u" : "y"} * params.source${source}Width + ${source === sources.upsampled ? "x / 2u" : "x"}) * ${blocks}u;`).join("\n    ") : `cachedBase0[load] = (y * params.inputWidth + x) * ${inputBlocks}u;`;
  const loads = tileM * tileKBlocks / (workgroupX * workgroupY);
  return (
    /* wgsl */
    `
  ${baseOffset ? `var cachedBase0: array<u32, ${loads}>;
  ${sources ? `var cachedBase1: array<u32, ${loads}>;` : ""}` : `var cachedX: array<u32, ${loads}>;
  var cachedY: array<u32, ${loads}>;`}
  var cachedMask: array<u32, ${loads}>;
  for (var load = 0u; load < ${loads}u; load++) {
    let loadIndex = localLinear + load * ${workgroupX * workgroupY}u;
    let spatial = workgroupId.x * ${tileM}u + loadIndex / ${tileKBlocks}u;
    let x = spatial % params.outputWidth;
    let y = spatial / params.outputWidth;
    ${baseOffset ? baseAssignments : `cachedX[load] = x;
    cachedY[load] = y;`}
    let columns =
      select(0u, 0x049u, x > 0u && x - 1u < ${width}) |
      select(0u, 0x092u, x < ${width}) |
      select(0u, 0x124u, x + 1u < ${width});
    let rows =
      select(0u, 0x007u, y > 0u && y - 1u < ${height}) |
      select(0u, 0x038u, y < ${height}) |
      select(0u, 0x1c0u, y + 1u < ${height});
    cachedMask[load] = select(0u, columns & rows, spatial < spatialCount)${baseOffset && sources ? " | ((x & 1u) << 9u) | ((y & 1u) << 10u)" : ""};
  }
  var channelBlock = (localLinear % ${tileKBlocks}u) % ${inputBlocks}u;
  var filterPosition = (localLinear % ${tileKBlocks}u) / ${inputBlocks}u;
`
  );
}
function tiledAddressAdvanceCode(inputBlocks, gemm) {
  const { tileKBlocks } = gemmTile(gemm);
  return (
    /* wgsl */
    `
    channelBlock += ${tileKBlocks % inputBlocks}u;
    let carry = channelBlock >= ${inputBlocks}u;
    channelBlock -= select(0u, ${inputBlocks}u, carry);
    filterPosition += ${Math.floor(tileKBlocks / inputBlocks)}u + select(0u, 1u, carry);
`
  );
}
function tiledIncrementalInputCode(valueType, readValue, gemm) {
  const { workgroupX, workgroupY, tileM, tileKBlocks } = gemmTile(gemm);
  const loads = tileM * tileKBlocks / (workgroupX * workgroupY);
  return (
    /* wgsl */
    `
    let inputBlock = channelBlock;
    let kernelY = filterPosition / 3u;
    let kernelX = filterPosition % 3u;
    for (var load = 0u; load < ${loads}u; load++) {
      let loadIndex = localLinear + load * ${workgroupX * workgroupY}u;
      var value = ${valueType}(0.0);
      if (filterPosition < 9u && (cachedMask[load] & (1u << filterPosition)) != 0u) {
        ${gemm.addressMode === "base-offset" ? "" : `let inputX = i32(cachedX[load]) + i32(kernelX) - 1;
        let inputY = i32(cachedY[load]) + i32(kernelY) - 1;`}
        ${readValue}
      }
      inputTile[${gemmSharedInputIndex("loadIndex", gemm)}] = value;
    }
`
  );
}
function createTiledConvShader(precision, outputPrecision, activation2, inputBlocks, outputBlocks, gemm) {
  const { workgroupX, workgroupY, rowsPerThread, tileM, tileNBlocks, tileKBlocks } = gemmTile(gemm);
  const { addressMode, weightLayout } = gemm;
  const inputType = storageVecType2(precision);
  const outputType = storageVecType2(outputPrecision);
  const packedInput = gemmPackedLoad(precision, gemm, false);
  const packedWeights = gemmPackedLoad(precision, gemm, true);
  const inputStorageType = packedInput ? "vec2<u32>" : inputType;
  const weightStorageType = packedWeights ? "vec2<u32>" : inputType;
  const stored = storeExpression(activationExpression("acc", activation2), outputPrecision);
  const workgroupThreads = workgroupX * workgroupY;
  const inputTileValues = tileM * tileKBlocks;
  const weightTileValues = tileKBlocks * tileNBlocks * 4;
  return (
    /* wgsl */
    `${shaderPreamble2(precision)}
struct Params {
  inputWidth: u32,
  inputHeight: u32,
  outputWidth: u32,
  outputHeight: u32,
  inputBlocks: u32,
  outputBlocks: u32,
}
@group(0) @binding(0) var<storage, read> inputData: array<${inputStorageType}>;
@group(0) @binding(1) var<storage, read> weights: array<${weightStorageType}>;
@group(0) @binding(2) var<storage, read> bias: array<vec4<f32>>;
@group(0) @binding(3) var<storage, read_write> outputData: array<${outputType}>;
@group(0) @binding(4) var<uniform> params: Params;

var<workgroup> inputTile: array<${inputType}, ${gemmSharedSizes(gemm).input}>;
var<workgroup> weightTile: array<${inputType}, ${gemmSharedSizes(gemm).weights}>;

@compute @workgroup_size(${workgroupX}, ${workgroupY}, 1)
fn main(
  @builtin(local_invocation_id) localId: vec3<u32>,
  @builtin(workgroup_id) workgroupId: vec3<u32>
) {
  let spatialBase =
    workgroupId.x * ${tileM}u +
    localId.y * ${rowsPerThread}u;
  let outputBlock =
    workgroupId.y * ${tileNBlocks}u + localId.x;
  let spatialCount = params.outputWidth * params.outputHeight;
  var acc: array<vec4<f32>, ${rowsPerThread}>;
  if (outputBlock < ${outputBlocks}u) {
    for (var row = 0u; row < ${rowsPerThread}u; row++) {
      acc[row] = bias[outputBlock];
    }
  }

  let localLinear =
    localId.y * ${workgroupX}u + localId.x;
  ${addressMode !== "analytic" ? tiledAddressCacheCode(inputBlocks, false, gemm) : ""}
  let totalK = ${inputBlocks * 9}u;
  for (var kBase = 0u; kBase < totalK; kBase += ${tileKBlocks}u) {
    ${addressMode !== "analytic" ? tiledIncrementalInputCode(inputType, `
        ${addressMode === "base-offset" ? `let offset = (i32(kernelY) - 1) * i32(params.inputWidth) + i32(kernelX) - 1;
        let inputIndex = cachedBase0[load] + u32(offset * ${inputBlocks}) + inputBlock;` : `let inputIndex = (u32(inputY) * params.inputWidth + u32(inputX)) *
          ${inputBlocks}u + inputBlock;`}
        value = ${gemmLoadExpression("inputData[inputIndex]", packedInput)};
    `, gemm) : (
      /* wgsl */
      `
    for (
      var loadIndex = localLinear;
      loadIndex < ${inputTileValues}u;
      loadIndex += ${workgroupThreads}u
    ) {
      let tileSpatial = loadIndex / ${tileKBlocks}u;
      let tileK = loadIndex % ${tileKBlocks}u;
      let inputSpatialIndex =
        workgroupId.x * ${tileM}u + tileSpatial;
      let kIndex = kBase + tileK;
      var value = ${inputType}(0.0);
      if (inputSpatialIndex < spatialCount && kIndex < totalK) {
        let outputY = inputSpatialIndex / params.outputWidth;
        let outputX = inputSpatialIndex % params.outputWidth;
        let inputBlock = kIndex % ${inputBlocks}u;
        let kernelIndex = kIndex / ${inputBlocks}u;
        let kernelY = kernelIndex / 3u;
        let kernelX = kernelIndex % 3u;
        let inputY = i32(outputY) + i32(kernelY) - 1;
        let inputX = i32(outputX) + i32(kernelX) - 1;
        if (
          inputY >= 0 && inputY < i32(params.inputHeight) &&
          inputX >= 0 && inputX < i32(params.inputWidth)
        ) {
          let inputIndex =
            (u32(inputY) * params.inputWidth + u32(inputX)) *
            ${inputBlocks}u + inputBlock;
          value = ${gemmLoadExpression("inputData[inputIndex]", packedInput)};
        }
      }
      inputTile[${gemmSharedInputIndex("loadIndex", gemm)}] = value;
    }
    `
    )}

    for (
      var loadIndex = localLinear;
      loadIndex < ${weightTileValues}u;
      loadIndex += ${workgroupThreads}u
    ) {
      let tileK = loadIndex / ${tileNBlocks * 4}u;
      let outputRemainder = loadIndex % ${tileNBlocks * 4}u;
      let tileOutputBlock = outputRemainder / 4u;
      let outputLane = outputRemainder % 4u;
      let loadedOutputBlock =
        workgroupId.y * ${tileNBlocks}u + tileOutputBlock;
      let kIndex = kBase + tileK;
      var value = ${inputType}(0.0);
      if (loadedOutputBlock < ${outputBlocks}u && kIndex < totalK) {
        ${weightLayout === "k-major" ? (
      /* wgsl */
      `
        let weightIndex = (kIndex * ${outputBlocks}u + loadedOutputBlock) * 4u + outputLane;
        `
    ) : addressMode !== "analytic" ? (
      /* wgsl */
      `
        let weightIndex = (loadedOutputBlock * ${inputBlocks * 9}u + kIndex) * 4u + outputLane;
        `
    ) : (
      /* wgsl */
      `
        let inputBlock = kIndex % ${inputBlocks}u;
        let kernelIndex = kIndex / ${inputBlocks}u;
        let kernelY = kernelIndex / 3u;
        let kernelX = kernelIndex % 3u;
        let weightIndex =
          ((((loadedOutputBlock * 3u + kernelY) * 3u + kernelX) *
            ${inputBlocks}u + inputBlock) * 4u + outputLane);
        `
    )}
        value = ${gemmLoadExpression("weights[weightIndex]", packedWeights)};
      }
      weightTile[${gemmSharedWeightIndex("loadIndex", gemm)}] = value;
    }

    workgroupBarrier();
    ${tiledAccumulationCode(precision, gemm)}
    workgroupBarrier();
    ${addressMode !== "analytic" ? tiledAddressAdvanceCode(inputBlocks, gemm) : ""}
  }

  if (outputBlock < ${outputBlocks}u) {
    for (var row = 0u; row < ${rowsPerThread}u; row++) {
      let spatialIndex = spatialBase + row;
      if (spatialIndex < spatialCount) {
        let outputIndex = spatialIndex * ${outputBlocks}u + outputBlock;
        outputData[outputIndex] = ${stored.replaceAll("acc", "acc[row]")};
      }
    }
  }
}
`
  );
}
function createFusedConvPoolShader(precision, activation2, inputBlocks, outputBlocks) {
  const valueType = storageVecType2(precision);
  const activated = activationExpression("acc", activation2);
  return (
    /* wgsl */
    `${shaderPreamble2(precision)}
struct Params {
  inputWidth: u32,
  inputHeight: u32,
  outputWidth: u32,
  outputHeight: u32,
  inputBlocks: u32,
  outputBlocks: u32,
}
@group(0) @binding(0) var<storage, read> inputData: array<${valueType}>;
@group(0) @binding(1) var<storage, read> weights: array<${valueType}>;
@group(0) @binding(2) var<storage, read> bias: array<vec4<f32>>;
@group(0) @binding(3) var<storage, read_write> outputData: array<${valueType}>;
@group(0) @binding(4) var<uniform> params: Params;

@compute @workgroup_size(${WORKGROUP_SIZE3}, ${WORKGROUP_SIZE3}, 1)
fn main(@builtin(global_invocation_id) gid: vec3<u32>) {
  if (gid.x >= params.outputWidth || gid.y >= params.outputHeight || gid.z >= ${outputBlocks}u) {
    return;
  }
  var pooled = vec4<f32>(-3.402823466e+38);
  for (var py = 0u; py < 2u; py++) {
    let centerY = gid.y * 2u + py;
    if (centerY >= params.inputHeight) { continue; }
    for (var px = 0u; px < 2u; px++) {
      let centerX = gid.x * 2u + px;
      if (centerX >= params.inputWidth) { continue; }
      var acc = bias[gid.z];
      for (var ky = 0u; ky < 3u; ky++) {
        let inputY = i32(centerY) + i32(ky) - 1;
        if (inputY < 0 || inputY >= i32(params.inputHeight)) { continue; }
        for (var kx = 0u; kx < 3u; kx++) {
          let inputX = i32(centerX) + i32(kx) - 1;
          if (inputX < 0 || inputX >= i32(params.inputWidth)) { continue; }
          let pixelBase = (u32(inputY) * params.inputWidth + u32(inputX)) * ${inputBlocks}u;
          for (var inputBlock = 0u; inputBlock < ${inputBlocks}u; inputBlock++) {
            ${accumulationCode2("inputData[pixelBase + inputBlock]", `((((gid.z * 3u + ky) * 3u + kx) * ${inputBlocks}u + inputBlock) * 4u)`, precision)}
          }
        }
      }
      pooled = max(pooled, ${activated});
    }
  }
  let outputIndex = (gid.y * params.outputWidth + gid.x) * ${outputBlocks}u + gid.z;
  outputData[outputIndex] = ${storeExpression("pooled", precision)};
}
`
  );
}
function createMaxPoolShader(precision, outputBlocks, coalesced) {
  const valueType = storageVecType2(precision);
  return (
    /* wgsl */
    `${shaderPreamble2(precision)}
struct Params {
  inputWidth: u32,
  inputHeight: u32,
  outputWidth: u32,
  outputHeight: u32,
  outputBlocks: u32,
}
@group(0) @binding(0) var<storage, read> inputData: array<${valueType}>;
@group(0) @binding(1) var<storage, read_write> outputData: array<${valueType}>;
@group(0) @binding(2) var<uniform> params: Params;

@compute @workgroup_size(${WORKGROUP_SIZE3}, ${WORKGROUP_SIZE3}, 1)
fn main(
  @builtin(global_invocation_id) gid: vec3<u32>${coalesced ? ",\n  @builtin(num_workgroups) groupCount: vec3<u32>" : ""}
) {
  ${coalesced ? `let linearX = gid.x + gid.z * groupCount.x * ${WORKGROUP_SIZE3}u;
  let outputBlock = linearX % ${outputBlocks}u;
  let outputX = linearX / ${outputBlocks}u;` : `let outputBlock = gid.z;
  let outputX = gid.x;`}
  if (
    outputX >= params.outputWidth ||
    gid.y >= params.outputHeight ||
    outputBlock >= ${outputBlocks}u
  ) {
    return;
  }
  var pooled = vec4<f32>(-3.402823466e+38);
  for (var py = 0u; py < 2u; py++) {
    let inputY = gid.y * 2u + py;
    if (inputY >= params.inputHeight) { continue; }
    for (var px = 0u; px < 2u; px++) {
      let inputX = outputX * 2u + px;
      if (inputX >= params.inputWidth) { continue; }
      let inputIndex =
        (inputY * params.inputWidth + inputX) * ${outputBlocks}u + outputBlock;
      pooled = max(pooled, vec4<f32>(inputData[inputIndex]));
    }
  }
  let outputIndex =
    (gid.y * params.outputWidth + outputX) * ${outputBlocks}u + outputBlock;
  outputData[outputIndex] = ${storeExpression("pooled", precision)};
}
`
  );
}
function createTiledDecoderShader(precision, outputPrecision, activation2, sourceBlocks, upsampledSource, outputBlocks, gemm) {
  const { workgroupX, workgroupY, rowsPerThread, tileM, tileNBlocks, tileKBlocks } = gemmTile(gemm);
  const { addressMode, weightLayout } = gemm;
  const valueType = storageVecType2(precision);
  const outputType = storageVecType2(outputPrecision);
  const packedInput = gemmPackedLoad(precision, gemm, false);
  const packedWeights = gemmPackedLoad(precision, gemm, true);
  const inputStorageType = packedInput ? "vec2<u32>" : valueType;
  const weightStorageType = packedWeights ? "vec2<u32>" : valueType;
  const inputBlocks = sourceBlocks[0] + sourceBlocks[1];
  const stored = storeExpression(activationExpression("acc[row]", activation2), outputPrecision);
  const workgroupThreads = workgroupX * workgroupY;
  const inputTileValues = tileM * tileKBlocks;
  const weightTileValues = tileKBlocks * tileNBlocks * 4;
  const sourceRead = (source, blockExpression) => {
    const sourceX = source === upsampledSource ? "u32(inputX) / 2u" : "u32(inputX)";
    const sourceY = source === upsampledSource ? "u32(inputY) / 2u" : "u32(inputY)";
    return (
      /* wgsl */
      `
          {
            let sourceBlock = ${blockExpression};
            ${addressMode === "base-offset" ? `let dx = ${source === upsampledSource ? "(i32((cachedMask[load] >> 9u) & 1u) + i32(kernelX) - 1) >> 1u" : "i32(kernelX) - 1"};
            let dy = ${source === upsampledSource ? "(i32((cachedMask[load] >> 10u) & 1u) + i32(kernelY) - 1) >> 1u" : "i32(kernelY) - 1"};
            let offset = (dy * i32(params.source${source}Width) + dx) * ${sourceBlocks[source]};
            let sourceIndex = cachedBase${source}[load] + u32(offset) + sourceBlock;` : `let sourceX = ${sourceX};
            let sourceY = ${sourceY};
            let sourceIndex =
              (sourceY * params.source${source}Width + sourceX) *
              ${sourceBlocks[source]}u + sourceBlock;`}
            value = ${gemmLoadExpression(`input${source}[sourceIndex]`, packedInput)};
          }`
    );
  };
  return (
    /* wgsl */
    `${shaderPreamble2(precision)}
struct Params {
  outputWidth: u32,
  outputHeight: u32,
  outputBlocks: u32,
  inputBlocks: u32,
  source0Width: u32,
  source0Height: u32,
  source1Width: u32,
  source1Height: u32,
}
@group(0) @binding(0) var<storage, read> input0: array<${inputStorageType}>;
@group(0) @binding(1) var<storage, read> input1: array<${inputStorageType}>;
@group(0) @binding(2) var<storage, read> weights: array<${weightStorageType}>;
@group(0) @binding(3) var<storage, read> bias: array<vec4<f32>>;
@group(0) @binding(4) var<storage, read_write> outputData: array<${outputType}>;
@group(0) @binding(5) var<uniform> params: Params;

var<workgroup> inputTile: array<${valueType}, ${gemmSharedSizes(gemm).input}>;
var<workgroup> weightTile: array<${valueType}, ${gemmSharedSizes(gemm).weights}>;

@compute @workgroup_size(${workgroupX}, ${workgroupY}, 1)
fn main(
  @builtin(local_invocation_id) localId: vec3<u32>,
  @builtin(workgroup_id) workgroupId: vec3<u32>
) {
  let spatialBase =
    workgroupId.x * ${tileM}u +
    localId.y * ${rowsPerThread}u;
  let outputBlock =
    workgroupId.y * ${tileNBlocks}u + localId.x;
  let spatialCount = params.outputWidth * params.outputHeight;
  var acc: array<vec4<f32>, ${rowsPerThread}>;
  if (outputBlock < ${outputBlocks}u) {
    for (var row = 0u; row < ${rowsPerThread}u; row++) {
      acc[row] = bias[outputBlock];
    }
  }

  let localLinear =
    localId.y * ${workgroupX}u + localId.x;
  ${addressMode !== "analytic" ? tiledAddressCacheCode(inputBlocks, true, gemm, { blocks: sourceBlocks, upsampled: upsampledSource }) : ""}
  let totalK = ${inputBlocks * 9}u;
  for (var kBase = 0u; kBase < totalK; kBase += ${tileKBlocks}u) {
    ${addressMode !== "analytic" ? gemm.decoderLoad === "source-first" ? `
    if (channelBlock < ${sourceBlocks[0]}u) {
      ${tiledIncrementalInputCode(valueType, sourceRead(0, "inputBlock"), gemm)}
    } else {
      ${tiledIncrementalInputCode(valueType, sourceRead(1, `inputBlock - ${sourceBlocks[0]}u`), gemm)}
    }
    ` : tiledIncrementalInputCode(valueType, `
        if (inputBlock < ${sourceBlocks[0]}u) {
          ${sourceRead(0, "inputBlock")}
        } else {
          ${sourceRead(1, `inputBlock - ${sourceBlocks[0]}u`)}
        }
    `, gemm) : (
      /* wgsl */
      `
    for (
      var loadIndex = localLinear;
      loadIndex < ${inputTileValues}u;
      loadIndex += ${workgroupThreads}u
    ) {
      let tileSpatial = loadIndex / ${tileKBlocks}u;
      let tileK = loadIndex % ${tileKBlocks}u;
      let outputSpatialIndex =
        workgroupId.x * ${tileM}u + tileSpatial;
      let kIndex = kBase + tileK;
      var value = ${valueType}(0.0);
      if (outputSpatialIndex < spatialCount && kIndex < totalK) {
        let outputY = outputSpatialIndex / params.outputWidth;
        let outputX = outputSpatialIndex % params.outputWidth;
        let inputBlock = kIndex % ${inputBlocks}u;
        let kernelIndex = kIndex / ${inputBlocks}u;
        let kernelY = kernelIndex / 3u;
        let kernelX = kernelIndex % 3u;
        let inputY = i32(outputY) + i32(kernelY) - 1;
        let inputX = i32(outputX) + i32(kernelX) - 1;
        if (
          inputY >= 0 && inputY < i32(params.outputHeight) &&
          inputX >= 0 && inputX < i32(params.outputWidth)
        ) {
          if (inputBlock < ${sourceBlocks[0]}u) {
            ${sourceRead(0, "inputBlock")}
          } else {
            ${sourceRead(1, `inputBlock - ${sourceBlocks[0]}u`)}
          }
        }
      }
      inputTile[${gemmSharedInputIndex("loadIndex", gemm)}] = value;
    }
    `
    )}

    for (
      var loadIndex = localLinear;
      loadIndex < ${weightTileValues}u;
      loadIndex += ${workgroupThreads}u
    ) {
      let tileK = loadIndex / ${tileNBlocks * 4}u;
      let outputRemainder = loadIndex % ${tileNBlocks * 4}u;
      let tileOutputBlock = outputRemainder / 4u;
      let outputLane = outputRemainder % 4u;
      let loadedOutputBlock =
        workgroupId.y * ${tileNBlocks}u + tileOutputBlock;
      let kIndex = kBase + tileK;
      var value = ${valueType}(0.0);
      if (loadedOutputBlock < ${outputBlocks}u && kIndex < totalK) {
        ${weightLayout === "k-major" ? (
      /* wgsl */
      `
        let weightIndex = (kIndex * ${outputBlocks}u + loadedOutputBlock) * 4u + outputLane;
        `
    ) : addressMode !== "analytic" ? (
      /* wgsl */
      `
        let weightIndex = (loadedOutputBlock * ${inputBlocks * 9}u + kIndex) * 4u + outputLane;
        `
    ) : (
      /* wgsl */
      `
        let inputBlock = kIndex % ${inputBlocks}u;
        let kernelIndex = kIndex / ${inputBlocks}u;
        let kernelY = kernelIndex / 3u;
        let kernelX = kernelIndex % 3u;
        let weightIndex =
          ((((loadedOutputBlock * 3u + kernelY) * 3u + kernelX) *
            ${inputBlocks}u + inputBlock) * 4u + outputLane);
        `
    )}
        value = ${gemmLoadExpression("weights[weightIndex]", packedWeights)};
      }
      weightTile[${gemmSharedWeightIndex("loadIndex", gemm)}] = value;
    }

    workgroupBarrier();
    ${tiledAccumulationCode(precision, gemm)}
    workgroupBarrier();
    ${addressMode !== "analytic" ? tiledAddressAdvanceCode(inputBlocks, gemm) : ""}
  }

  if (outputBlock < ${outputBlocks}u) {
    for (var row = 0u; row < ${rowsPerThread}u; row++) {
      let spatialIndex = spatialBase + row;
      if (spatialIndex < spatialCount) {
        let outputIndex = spatialIndex * ${outputBlocks}u + outputBlock;
        outputData[outputIndex] = ${stored};
      }
    }
  }
}
`
  );
}
function createTiledSubpixelDecoderShader(precision, outputPrecision, activation2, sourceBlocks, upsampledSource, outputBlocks, gemm) {
  const tile = gemmTile(gemm);
  const { workgroupX, workgroupY, rowsPerThread, tileM, tileNBlocks, tileKBlocks } = tile;
  const threads = workgroupX * workgroupY;
  const loads = tileM * tileKBlocks / threads;
  const valueType = storageVecType2(precision);
  const packedInput = gemmPackedLoad(precision, gemm, false);
  const packedWeights = gemmPackedLoad(precision, gemm, true);
  const upBlocks = sourceBlocks[upsampledSource];
  const skipSource = 1 - upsampledSource;
  const skipBlocks = sourceBlocks[skipSource];
  const reduction = (source, upsampled) => {
    const blocks = sourceBlocks[source];
    const taps = upsampled ? 4 : 9;
    const weightOffset = upsampled ? `phase * ${4 * upBlocks * outputBlocks * 4}u` : `${SUBPIXEL_MATRICES * upBlocks * outputBlocks * 4}u`;
    const offset = upsampled ? `(i32(tap / 2u) + i32(phaseY) - 1) * i32(params.source${source}Width) + i32(tap % 2u) + i32(phaseX) - 1` : `(i32(tap / 3u) - 1) * i32(params.source${source}Width) + i32(tap % 3u) - 1`;
    return (
      /* wgsl */
      `
  for (var kBase = 0u; kBase < ${taps * blocks}u; kBase += ${tileKBlocks}u) {
    let inputK = kBase + localLinear % ${tileKBlocks}u;
    let tap = inputK / ${blocks}u;
    let channel = inputK % ${blocks}u;
    for (var load = 0u; load < ${loads}u; load++) {
      let i = localLinear + load * ${threads}u;
      var value = ${valueType}(0.0);
      if (tap < ${taps}u && (mask${source}[load] & (1u << tap)) != 0u) {
        let offset = ${offset};
        let index = u32(base${source}[load] + offset) * ${blocks}u + channel;
        value = ${gemmLoadExpression(`input${source}[index]`, packedInput)};
      }
      inputTile[${gemmSharedInputIndex("i", gemm)}] = value;
    }
    for (var i = localLinear; i < ${tileKBlocks * tileNBlocks * 4}u; i += ${threads}u) {
      let k = kBase + i / ${tileNBlocks * 4}u;
      let outputBlock = workgroupId.y * ${tileNBlocks}u + (i % ${tileNBlocks * 4}u) / 4u;
      var value = ${valueType}(0.0);
      if (k < ${taps * blocks}u && outputBlock < ${outputBlocks}u) {
        let index = ${weightOffset} + (k * ${outputBlocks}u + outputBlock) * 4u + i % 4u;
        value = ${gemmLoadExpression("weights[index]", packedWeights)};
      }
      weightTile[${gemmSharedWeightIndex("i", gemm)}] = value;
    }
    workgroupBarrier();
    ${tiledAccumulationCode(precision, gemm)}
    workgroupBarrier();
  }`
    );
  };
  const cache = (source, upsampled) => {
    const taps = upsampled ? 4 : 9;
    const side = upsampled ? 2 : 3;
    const x = upsampled ? "x" : "x * 2u + phaseX";
    const y = upsampled ? "y" : "y * 2u + phaseY";
    return (
      /* wgsl */
      `
    let x${source} = i32(${x});
    let y${source} = i32(${y});
    base${source}[load] = y${source} * i32(params.source${source}Width) + x${source};
    var bits${source} = 0u;
    for (var tap = 0u; tap < ${taps}u; tap++) {
      let sx = x${source} + i32(tap % ${side}u) ${upsampled ? "+ i32(phaseX)" : ""} - 1;
      let sy = y${source} + i32(tap / ${side}u) ${upsampled ? "+ i32(phaseY)" : ""} - 1;
      if (valid && sx >= 0 && sy >= 0 && sx < i32(params.source${source}Width) && sy < i32(params.source${source}Height)) {
        bits${source} |= 1u << tap;
      }
    }
    mask${source}[load] = bits${source};`
    );
  };
  return (
    /* wgsl */
    `${shaderPreamble2(precision)}
struct Params {
  outputWidth: u32, outputHeight: u32, outputBlocks: u32, inputBlocks: u32,
  source0Width: u32, source0Height: u32, source1Width: u32, source1Height: u32,
}
@group(0) @binding(0) var<storage, read> input0: array<${packedInput ? "vec2<u32>" : valueType}>;
@group(0) @binding(1) var<storage, read> input1: array<${packedInput ? "vec2<u32>" : valueType}>;
@group(0) @binding(2) var<storage, read> weights: array<${packedWeights ? "vec2<u32>" : valueType}>;
@group(0) @binding(3) var<storage, read> bias: array<vec4<f32>>;
@group(0) @binding(4) var<storage, read_write> outputData: array<${storageVecType2(outputPrecision)}>;
@group(0) @binding(5) var<uniform> params: Params;
var<workgroup> inputTile: array<${valueType}, ${gemmSharedSizes(gemm).input}>;
var<workgroup> weightTile: array<${valueType}, ${gemmSharedSizes(gemm).weights}>;

@compute @workgroup_size(${workgroupX}, ${workgroupY}, 1)
fn main(@builtin(local_invocation_id) localId: vec3<u32>, @builtin(workgroup_id) workgroupId: vec3<u32>) {
  let phase = workgroupId.z;
  let phaseX = phase & 1u;
  let phaseY = phase >> 1u;
  let phaseWidth = (params.outputWidth + 1u) / 2u;
  let localLinear = localId.y * ${workgroupX}u + localId.x;
  let outputBlock = workgroupId.y * ${tileNBlocks}u + localId.x;
  var acc: array<vec4<f32>, ${rowsPerThread}>;
  if (outputBlock < ${outputBlocks}u) {
    for (var row = 0u; row < ${rowsPerThread}u; row++) { acc[row] = bias[outputBlock]; }
  }
  var base0: array<i32, ${loads}>;
  var base1: array<i32, ${loads}>;
  var mask0: array<u32, ${loads}>;
  var mask1: array<u32, ${loads}>;
  for (var load = 0u; load < ${loads}u; load++) {
    let spatial = workgroupId.x * ${tileM}u + (localLinear + load * ${threads}u) / ${tileKBlocks}u;
    let x = spatial % phaseWidth;
    let y = spatial / phaseWidth;
    let valid = x * 2u + phaseX < params.outputWidth && y * 2u + phaseY < params.outputHeight;
    ${cache(upsampledSource, true)}
    ${cache(skipSource, false)}
  }
  ${reduction(upsampledSource, true)}
  ${reduction(skipSource, false)}
  if (outputBlock < ${outputBlocks}u) {
    for (var row = 0u; row < ${rowsPerThread}u; row++) {
      let spatial = workgroupId.x * ${tileM}u + localId.y * ${rowsPerThread}u + row;
      let x = (spatial % phaseWidth) * 2u + phaseX;
      let y = (spatial / phaseWidth) * 2u + phaseY;
      if (x < params.outputWidth && y < params.outputHeight) {
        outputData[(y * params.outputWidth + x) * ${outputBlocks}u + outputBlock] = ${storeExpression(activationExpression("acc[row]", activation2), outputPrecision)};
      }
    }
  }
}
`
  );
}
function createFusedDecoderShader(precision, outputPrecision, activation2, sourceBlocks, upsampledSource, outputBlocks) {
  const valueType = storageVecType2(precision);
  const outputType = storageVecType2(outputPrecision);
  const inputBlocks = sourceBlocks[0] + sourceBlocks[1];
  const sourceCode = (source, blockOffset) => {
    const isUpsampled = source === upsampledSource;
    return (
      /* wgsl */
      `
      {
        let sourceX = ${isUpsampled ? "u32(inputX) / 2u" : "u32(inputX)"};
        let sourceY = ${isUpsampled ? "u32(inputY) / 2u" : "u32(inputY)"};
        let sourcePixelBase = (sourceY * params.source${source}Width + sourceX) * ${sourceBlocks[source]}u;
        for (var sourceBlock = 0u; sourceBlock < ${sourceBlocks[source]}u; sourceBlock++) {
          let inputBlock = ${blockOffset}u + sourceBlock;
          ${accumulationCode2(`input${source}[sourcePixelBase + sourceBlock]`, `((((gid.z * 3u + ky) * 3u + kx) * ${inputBlocks}u + inputBlock) * 4u)`, precision)}
        }
      }
`
    );
  };
  const stored = storeExpression(activationExpression("acc", activation2), outputPrecision);
  return (
    /* wgsl */
    `${shaderPreamble2(precision)}
struct Params {
  outputWidth: u32,
  outputHeight: u32,
  outputBlocks: u32,
  inputBlocks: u32,
  source0Width: u32,
  source0Height: u32,
  source1Width: u32,
  source1Height: u32,
}
@group(0) @binding(0) var<storage, read> input0: array<${valueType}>;
@group(0) @binding(1) var<storage, read> input1: array<${valueType}>;
@group(0) @binding(2) var<storage, read> weights: array<${valueType}>;
@group(0) @binding(3) var<storage, read> bias: array<vec4<f32>>;
@group(0) @binding(4) var<storage, read_write> outputData: array<${outputType}>;
@group(0) @binding(5) var<uniform> params: Params;

@compute @workgroup_size(${WORKGROUP_SIZE3}, ${WORKGROUP_SIZE3}, 1)
fn main(@builtin(global_invocation_id) gid: vec3<u32>) {
  if (gid.x >= params.outputWidth || gid.y >= params.outputHeight || gid.z >= ${outputBlocks}u) {
    return;
  }
  var acc = bias[gid.z];
  for (var ky = 0u; ky < 3u; ky++) {
    let inputY = i32(gid.y) + i32(ky) - 1;
    if (inputY < 0 || inputY >= i32(params.outputHeight)) { continue; }
    for (var kx = 0u; kx < 3u; kx++) {
      let inputX = i32(gid.x) + i32(kx) - 1;
      if (inputX < 0 || inputX >= i32(params.outputWidth)) { continue; }
      ${sourceCode(0, 0)}
      ${sourceCode(1, sourceBlocks[0])}
    }
  }
  let outputIndex = (gid.y * params.outputWidth + gid.x) * ${outputBlocks}u + gid.z;
  outputData[outputIndex] = ${stored};
}
`
  );
}
function createSpatialDecoderShader(precision, outputPrecision, activation2, sourceBlocks, upsampledSource, outputBlocks) {
  const valueType = storageVecType2(precision);
  const outputType = storageVecType2(outputPrecision);
  const inputBlocks = sourceBlocks[0] + sourceBlocks[1];
  const patchValues = SPATIAL_CONV_PATCH * SPATIAL_CONV_PATCH * inputBlocks;
  const workgroupThreads = SPATIAL_CONV_WORKGROUP * SPATIAL_CONV_WORKGROUP;
  const stored = storeExpression(activationExpression("acc", activation2), outputPrecision);
  const sourceRead = (source, blockExpression) => {
    const sourceX = source === upsampledSource ? "u32(inputX) / 2u" : "u32(inputX)";
    const sourceY = source === upsampledSource ? "u32(inputY) / 2u" : "u32(inputY)";
    return (
      /* wgsl */
      `
      let sourceBlock = ${blockExpression};
      let sourceIndex =
        (${sourceY} * params.source${source}Width + ${sourceX}) *
        ${sourceBlocks[source]}u + sourceBlock;
      value = input${source}[sourceIndex];`
    );
  };
  return (
    /* wgsl */
    `${shaderPreamble2(precision)}
struct Params {
  outputWidth: u32,
  outputHeight: u32,
  outputBlocks: u32,
  inputBlocks: u32,
  source0Width: u32,
  source0Height: u32,
  source1Width: u32,
  source1Height: u32,
}
@group(0) @binding(0) var<storage, read> input0: array<${valueType}>;
@group(0) @binding(1) var<storage, read> input1: array<${valueType}>;
@group(0) @binding(2) var<storage, read> weights: array<${valueType}>;
@group(0) @binding(3) var<storage, read> bias: array<vec4<f32>>;
@group(0) @binding(4) var<storage, read_write> outputData: array<${outputType}>;
@group(0) @binding(5) var<uniform> params: Params;

var<workgroup> inputPatch: array<${valueType}, ${patchValues}>;

@compute @workgroup_size(${SPATIAL_CONV_WORKGROUP}, ${SPATIAL_CONV_WORKGROUP}, 1)
fn main(
  @builtin(local_invocation_id) localId: vec3<u32>,
  @builtin(workgroup_id) workgroupId: vec3<u32>
) {
  let localLinear =
    localId.y * ${SPATIAL_CONV_WORKGROUP}u + localId.x;
  for (
    var loadIndex = localLinear;
    loadIndex < ${patchValues}u;
    loadIndex += ${workgroupThreads}u
  ) {
    let patchPixel = loadIndex / ${inputBlocks}u;
    let inputBlock = loadIndex % ${inputBlocks}u;
    let patchX = patchPixel % ${SPATIAL_CONV_PATCH}u;
    let patchY = patchPixel / ${SPATIAL_CONV_PATCH}u;
    let inputX =
      i32(workgroupId.x * ${SPATIAL_CONV_WORKGROUP}u + patchX) - 1;
    let inputY =
      i32(workgroupId.y * ${SPATIAL_CONV_WORKGROUP}u + patchY) - 1;
    var value = ${valueType}(0.0);
    if (
      inputX >= 0 && inputX < i32(params.outputWidth) &&
      inputY >= 0 && inputY < i32(params.outputHeight)
    ) {
      if (inputBlock < ${sourceBlocks[0]}u) {
        ${sourceRead(0, "inputBlock")}
      } else {
        ${sourceRead(1, `inputBlock - ${sourceBlocks[0]}u`)}
      }
    }
    inputPatch[loadIndex] = value;
  }
  workgroupBarrier();

  let outputX =
    workgroupId.x * ${SPATIAL_CONV_WORKGROUP}u + localId.x;
  let outputY =
    workgroupId.y * ${SPATIAL_CONV_WORKGROUP}u + localId.y;
  let outputBlock = workgroupId.z;
  if (
    outputX >= params.outputWidth || outputY >= params.outputHeight ||
    outputBlock >= ${outputBlocks}u
  ) {
    return;
  }

  var acc = bias[outputBlock];
  for (var ky = 0u; ky < 3u; ky++) {
    for (var kx = 0u; kx < 3u; kx++) {
      let patchBase =
        ((localId.y + ky) * ${SPATIAL_CONV_PATCH}u + localId.x + kx) *
        ${inputBlocks}u;
      for (var inputBlock = 0u; inputBlock < ${inputBlocks}u; inputBlock++) {
        ${accumulationCode2("inputPatch[patchBase + inputBlock]", `((((outputBlock * 3u + ky) * 3u + kx) * ${inputBlocks}u + inputBlock) * 4u)`, precision)}
      }
    }
  }
  let outputIndex =
    (outputY * params.outputWidth + outputX) * ${outputBlocks}u + outputBlock;
  outputData[outputIndex] = ${stored};
}
`
  );
}
function createInputPackShader(precision, sourceCount) {
  const outputType = storageVecType2(precision);
  const inputBindings = Array.from({ length: sourceCount }, (_, index) => `@group(0) @binding(${index}) var<storage, read> input${index}: array<vec4<f32>>;`).join("\n");
  const readBranches = Array.from({ length: sourceCount }, (_, index) => {
    const firstChannel = index * 3;
    return `if (channel < ${firstChannel + 3}u) { return input${index}[pixel][channel - ${firstChannel}u]; }`;
  }).join("\n  ");
  const outputBinding = sourceCount;
  const paramsBinding = sourceCount + 1;
  return (
    /* wgsl */
    `${shaderPreamble2(precision)}
struct Params {
  width: u32,
  height: u32,
  outputBlocks: u32,
  inputChannels: u32,
}
${inputBindings}
@group(0) @binding(${outputBinding}) var<storage, read_write> outputData: array<${outputType}>;
@group(0) @binding(${paramsBinding}) var<uniform> params: Params;

fn readChannel(pixel: u32, channel: u32) -> f32 {
  ${readBranches}
  return 0.0;
}

@compute @workgroup_size(${WORKGROUP_SIZE3}, ${WORKGROUP_SIZE3}, 1)
fn main(@builtin(global_invocation_id) gid: vec3<u32>) {
  if (gid.x >= params.width || gid.y >= params.height || gid.z >= params.outputBlocks) {
    return;
  }
  let pixel = gid.y * params.width + gid.x;
  let firstChannel = gid.z * 4u;
  let value = vec4<f32>(
    readChannel(pixel, firstChannel),
    readChannel(pixel, firstChannel + 1u),
    readChannel(pixel, firstChannel + 2u),
    readChannel(pixel, firstChannel + 3u)
  );
  outputData[pixel * params.outputBlocks + gid.z] = ${storeExpression("value", precision)};
}
`
  );
}
var SUBGROUP_MATRIX_FEATURE = "chromium-experimental-subgroup-matrix";
var COOPERATIVE_MATRIX_FEATURE = "wgpu-cooperative-matrix";
var SUBGROUP_MATRIX_TILE_WIDTH = 32;
var SUBGROUP_MATRIX_TILE_HEIGHT = 8;
var SUBGROUP_MATRIX_SUBGROUPS = 4;
var SUBGROUP_MATRIX_MIN_WORKGROUPS = 1024;
function selectSubgroupMatrixConfig(device, accumulation = "f32") {
  const dialect = device.features.has(SUBGROUP_MATRIX_FEATURE) ? "tint" : device.features.has(COOPERATIVE_MATRIX_FEATURE) ? "naga" : void 0;
  if (!dialect || !device.features.has("subgroups"))
    return void 0;
  const info = device.adapterInfo;
  const subgroupSize = info?.subgroupMaxSize ?? 0;
  if (!info || !subgroupSize || info.subgroupMinSize !== subgroupSize)
    return void 0;
  const preferences = accumulation === "f16" ? [["f16", "f16"], ["f16", "f32"], ["f32", "f32"]] : [["f16", "f32"], ["f32", "f32"], ["f16", "f16"]];
  const shader16 = device.features.has("shader-f16");
  for (const [componentType, resultType] of preferences) {
    if (!shader16 && (componentType === "f16" || resultType === "f16"))
      continue;
    for (const size of [8, 16]) {
      const match = info.subgroupMatrixConfigs?.find((config) => config.componentType === componentType && config.resultComponentType === resultType && config.M === size && config.N === size && config.K === size);
      if (match) {
        return {
          componentType,
          resultType,
          size,
          subgroupSize,
          dialect
        };
      }
    }
  }
  return void 0;
}
function subgroupMatrixFragments(config, options) {
  return options.outputFragments ?? 2;
}
function subgroupMatrixSharedBytes(config, outputFragments, subPixel, doubleBuffer) {
  const component = config.componentType === "f16" ? 2 : 4;
  const result = config.resultType === "f16" ? 2 : 4;
  const size = config.size;
  const halo = (SUBGROUP_MATRIX_TILE_HEIGHT + 2) * (SUBGROUP_MATRIX_TILE_WIDTH + 2) * size;
  const matrices = subPixel ? 16 : 9;
  return component * (doubleBuffer ? 2 : 1) * (halo + matrices * size * size * outputFragments) + result * SUBGROUP_MATRIX_SUBGROUPS * SUBGROUP_MATRIX_TILE_WIDTH * size;
}
function subgroupMatrixDialect(config) {
  const size = config.size;
  const naga = config.dialect === "naga";
  const matrixType = (scalar, tint, role) => naga ? `coop_mat${size}x${size}<${scalar}, ${role}>` : `subgroup_matrix_${tint}<${scalar}, ${size}, ${size}>`;
  const result = matrixType(config.resultType, "result", "C");
  return {
    left: matrixType(config.componentType, "left", "A"),
    right: matrixType(config.componentType, "right", "B"),
    result,
    load: (type, array, offset, stride) => naga ? `coopLoadT<${type}>(&${array}[${offset}], ${stride})` : `subgroupMatrixLoad<${type}, row_major>(&${array}, ${offset}, ${stride})`,
    store: (array, offset, value, stride) => naga ? `coopStoreT(${value}, &${array}[${offset}], ${stride});` : `subgroupMatrixStore<row_major>(&${array}, ${offset}, ${value}, ${stride});`,
    multiplyAdd: naga ? "coopMultiplyAdd" : "subgroupMatrixMultiplyAccumulate",
    declare: (name) => naga ? `var ${name}: ${result};` : `var ${name} = ${result}();`,
    // Naga provides subgroups without (and rejects) `enable subgroups`.
    extensions: naga ? "enable wgpu_cooperative_matrix;" : `enable subgroups;
enable chromium_experimental_subgroup_matrix;
diagnostic(off, chromium_experimental.subgroup_matrix_uniformity);`
  };
}
function subgroupMatrixChunkLoop(chunks, stages, body, threads, valueType, component, doubleBuffer) {
  const storeValue = (stage, value, base) => `{
        let staged = vec4<${component}>(${value});
        let base = ${base} + i * 4u;
        ${stage.array}[base] = staged.x;
        ${stage.array}[base + 1u] = staged.y;
        ${stage.array}[base + 2u] = staged.z;
        ${stage.array}[base + 3u] = staged.w;
      }`;
  const direct = (base) => stages.map((stage) => `
    for (var batch = 0u; batch < ${Math.ceil(stage.vectors / threads)}u; batch++) {
      let i = localIndex + batch * ${threads}u;
      if (i < ${stage.vectors}u) {
        var value = ${valueType}(0.0);
        ${stage.read}
        ${storeValue(stage, "value", base(stage))}
      }
    }`).join("");
  const bases = (buffer2) => stages.map((stage) => `let ${stage.array}Base = ${buffer2} * ${(stage.stride ?? stage.vectors) * 4}u;`).join("\n    ");
  if (!doubleBuffer || chunks < 2) {
    return (
      /* wgsl */
      `
  for (var chunk = 0u; chunk < ${chunks}u; chunk++) {
    let stageChunk = chunk;
    ${bases("0u")}
    ${direct((stage) => `${stage.array}Base`)}
    workgroupBarrier();
    ${body}
    workgroupBarrier();
  }`
    );
  }
  const registers = stages.map((stage) => Math.ceil(stage.vectors / threads));
  const prefetch = stages.map((stage, index) => Array.from({ length: registers[index] }, (_, slot) => `
      {
        let i = localIndex + ${slot * threads}u;
        var value = ${valueType}(0.0);
        if (i < ${stage.vectors}u) {
          ${stage.read}
        }
        prefetch${index}_${slot} = value;
      }`).join("")).join("");
  const declarations = stages.map((stage, index) => Array.from({ length: registers[index] }, (_, slot) => `var prefetch${index}_${slot} = ${valueType}(0.0);`).join("\n    ")).join("\n    ");
  const storePrefetched = stages.map((stage, index) => Array.from({ length: registers[index] }, (_, slot) => `
      {
        let i = localIndex + ${slot * threads}u;
        if (i < ${stage.vectors}u) ${storeValue(stage, `prefetch${index}_${slot}`, `next * ${(stage.stride ?? stage.vectors) * 4}u`)}
      }`).join("")).join("");
  return (
    /* wgsl */
    `
  {
    let stageChunk = 0u;
    ${direct(() => "0u")}
  }
  workgroupBarrier();
  for (var chunk = 0u; chunk < ${chunks}u; chunk++) {
    let buffer = chunk & 1u;
    let next = 1u - buffer;
    ${bases("buffer")}
    ${declarations}
    if (chunk + 1u < ${chunks}u) {
      let stageChunk = chunk + 1u;
      ${prefetch}
    }
    ${body}
    if (chunk + 1u < ${chunks}u) {
      ${storePrefetched}
    }
    workgroupBarrier();
  }`
  );
}
function subgroupMatrixTapLoop(config, body) {
  return config.dialect === "naga" ? Array.from({ length: 9 }, (_, tap) => `{ let tap = ${tap}u; ${body} }`).join("\n") : `for (var tap = 0u; tap < 9u; tap++) { ${body} }`;
}
function createSubgroupMatrixConvShader(precision, outputPrecision, activation2, inputBlocks, outputBlocks, config, outputFragments, doubleBuffer, decoder, pool2 = false) {
  const size = config.size;
  const component = config.componentType;
  const result = config.resultType;
  const tileWidth = SUBGROUP_MATRIX_TILE_WIDTH;
  const haloWidth = tileWidth + 2;
  const haloRows = SUBGROUP_MATRIX_TILE_HEIGHT + 2;
  const buffers = doubleBuffer ? 2 : 1;
  const chunkBlocks = size / 4;
  const chunks = Math.ceil(inputBlocks / chunkBlocks);
  const outputChannels = outputFragments * size;
  const pixelFragments = tileWidth / size;
  const threads = SUBGROUP_MATRIX_SUBGROUPS * config.subgroupSize;
  const valueType = storageVecType2(precision);
  const outputType = storageVecType2(outputPrecision);
  const { left, right, load, store, multiplyAdd, declare, extensions } = subgroupMatrixDialect(config);
  const accumulators = [];
  for (let row = 0; row < 2; row++) {
    for (let pixel = 0; pixel < pixelFragments; pixel++) {
      for (let fragment = 0; fragment < outputFragments; fragment++) {
        accumulators.push(`acc${row}_${pixel}_${fragment}`);
      }
    }
  }
  const declarations = accumulators.map(declare).join("\n  ");
  const rightLoads = Array.from({ length: outputFragments }, (_, fragment) => `let b${fragment} = ${load(right, "weightTile", `weightTileBase + tap * ${size * outputChannels}u + ${fragment * size}u`, `${outputChannels}u`)};`).join("\n      ");
  const multiplies = [];
  for (let row = 0; row < 2; row++) {
    for (let pixel = 0; pixel < pixelFragments; pixel++) {
      multiplies.push(`{
        let a = ${load(left, "inputTile", `inputTileBase + ((rowBase + ${row}u + ky) * ${haloWidth}u + ${pixel * size}u + kx) * ${size}u`, `${size}u`)};
        ${Array.from({ length: outputFragments }, (_, fragment) => `acc${row}_${pixel}_${fragment} = ${multiplyAdd}(a, b${fragment}, acc${row}_${pixel}_${fragment});`).join("\n        ")}
      }`);
    }
  }
  const tapBody = `let ky = tap / 3u;
      let kx = tap % 3u;
      ${rightLoads}
      ${multiplies.join("\n      ")}`;
  const taps = subgroupMatrixTapLoop(config, tapBody);
  const epilogues = [];
  if (pool2) {
    for (let fragment = 0; fragment < outputFragments; fragment++) {
      epilogues.push(`{
    var pooled = vec4<f32>(-3.402823e38);
    let pixel = lane / ${chunkBlocks}u;
    let outputBlock = blockBase + ${fragment * chunkBlocks}u + lane % ${chunkBlocks}u;
    ${Array.from({ length: 2 }, (_, row) => `
    ${Array.from({ length: pixelFragments }, (_2, pixel) => store("resultTile", `resultBase + ${pixel * size * size}u`, `acc${row}_${pixel}_${fragment}`, `${size}u`)).join("\n    ")}
    workgroupBarrier();
    {
      let base = resultBase + pixel * ${size * 2}u + (lane % ${chunkBlocks}u) * 4u;
      let first = vec4<f32>(resultTile[base], resultTile[base + 1u], resultTile[base + 2u], resultTile[base + 3u]);
      let second = vec4<f32>(resultTile[base + ${size}u], resultTile[base + ${size + 1}u], resultTile[base + ${size + 2}u], resultTile[base + ${size + 3}u]);
      if (tileY + rowBase + ${row}u < params.inputHeight) {
        pooled = max(pooled, first);
        if (tileX + pixel * 2u + 1u < params.inputWidth) { pooled = max(pooled, second); }
      }
    }
    workgroupBarrier();`).join("\n    ")}
    let outputX = tileX / 2u + pixel;
    let outputY = (tileY + rowBase) / 2u;
    if (outputX < params.outputWidth && outputY < params.outputHeight && outputBlock < ${outputBlocks}u) {
      let acc = pooled + bias[outputBlock];
      outputData[(outputY * params.outputWidth + outputX) * ${outputBlocks}u + outputBlock] = ${storeExpression(activationExpression("acc", activation2), outputPrecision)};
    }
  }`);
    }
  } else {
    for (let row = 0; row < 2; row++) {
      for (let fragment = 0; fragment < outputFragments; fragment++) {
        epilogues.push(`{
    ${Array.from({ length: pixelFragments }, (_, pixel) => store("resultTile", `resultBase + ${pixel * size * size}u`, `acc${row}_${pixel}_${fragment}`, `${size}u`)).join("\n    ")}
    workgroupBarrier();
    let outputY = tileY + rowBase + ${row}u;
    for (var e = lane; e < ${tileWidth * chunkBlocks}u; e += ${config.subgroupSize}u) {
      let pixel = e / ${chunkBlocks}u;
      let outputX = tileX + pixel;
      let outputBlock = blockBase + ${fragment * chunkBlocks}u + e % ${chunkBlocks}u;
      if (outputX < params.outputWidth && outputY < params.outputHeight && outputBlock < ${outputBlocks}u) {
        let base = resultBase + pixel * ${size}u + (e % ${chunkBlocks}u) * 4u;
        let acc = vec4<f32>(f32(resultTile[base]), f32(resultTile[base + 1u]),
          f32(resultTile[base + 2u]), f32(resultTile[base + 3u])) + bias[outputBlock];
        outputData[(outputY * params.outputWidth + outputX) * ${outputBlocks}u + outputBlock] = ${storeExpression(activationExpression("acc", activation2), outputPrecision)};
      }
    }
    workgroupBarrier();
  }`);
      }
    }
  }
  const sourceRead = decoder ? (() => {
    const [blocks0, blocks1] = decoder.sourceBlocks;
    const coordinates = (source) => source === decoder.upsampledSource ? `min(u32(inputY) / 2u, params.source${source}Height - 1u) * params.source${source}Width + min(u32(inputX) / 2u, params.source${source}Width - 1u)` : `u32(inputY) * params.source${source}Width + u32(inputX)`;
    return (
      /* wgsl */
      `if (block < ${blocks0}u) {
          value = input0[(${coordinates(0)}) * ${blocks0}u + block];
        } else {
          value = input1[(${coordinates(1)}) * ${blocks1}u + block - ${blocks0}u];
        }`
    );
  })() : `value = inputData[(u32(inputY) * params.inputWidth + u32(inputX)) * ${inputBlocks}u + block];`;
  const params = decoder ? `struct Params {
  outputWidth: u32,
  outputHeight: u32,
  outputBlocks: u32,
  inputBlocks: u32,
  source0Width: u32,
  source0Height: u32,
  source1Width: u32,
  source1Height: u32,
}
@group(0) @binding(0) var<storage, read> input0: array<${valueType}>;
@group(0) @binding(1) var<storage, read> input1: array<${valueType}>;
@group(0) @binding(2) var<storage, read> weights: array<${valueType}>;
@group(0) @binding(3) var<storage, read> bias: array<vec4<f32>>;
@group(0) @binding(4) var<storage, read_write> outputData: array<${outputType}>;
@group(0) @binding(5) var<uniform> params: Params;` : `struct Params {
  inputWidth: u32,
  inputHeight: u32,
  outputWidth: u32,
  outputHeight: u32,
  inputBlocks: u32,
  outputBlocks: u32,
}
@group(0) @binding(0) var<storage, read> inputData: array<${valueType}>;
@group(0) @binding(1) var<storage, read> weights: array<${valueType}>;
@group(0) @binding(2) var<storage, read> bias: array<vec4<f32>>;
@group(0) @binding(3) var<storage, read_write> outputData: array<${outputType}>;
@group(0) @binding(4) var<uniform> params: Params;`;
  const imageWidth = decoder ? "params.outputWidth" : "params.inputWidth";
  const imageHeight = decoder ? "params.outputHeight" : "params.inputHeight";
  const needsF16 = precision === "fp16" || outputPrecision === "fp16" || component === "f16" || result === "f16";
  return (
    /* wgsl */
    `${needsF16 ? "enable f16;\n" : ""}${extensions}
${params}

var<workgroup> inputTile: array<${component}, ${buffers * haloRows * haloWidth * size}>;
var<workgroup> weightTile: array<${component}, ${buffers * 9 * size * outputChannels}>;
var<workgroup> resultTile: array<${result}, ${SUBGROUP_MATRIX_SUBGROUPS * tileWidth * size}>;

@compute @workgroup_size(${threads})
fn main(
  @builtin(local_invocation_index) localIndex: u32,
  @builtin(workgroup_id) workgroupId: vec3<u32>,
  @builtin(subgroup_id) subgroup: u32,
  @builtin(subgroup_invocation_id) lane: u32
) {
  let tileX = workgroupId.x * ${tileWidth}u;
  let tileY = workgroupId.y * ${SUBGROUP_MATRIX_TILE_HEIGHT}u;
  let blockBase = workgroupId.z * ${outputChannels / 4}u;
  let rowBase = subgroup * 2u;
  let resultBase = subgroup * ${tileWidth * size}u;
  ${declarations}

  ${subgroupMatrixChunkLoop(chunks, [
      {
        array: "inputTile",
        vectors: haloRows * haloWidth * chunkBlocks,
        read: (
          /* wgsl */
          `let pixel = i / ${chunkBlocks}u;
      let block = stageChunk * ${chunkBlocks}u + i % ${chunkBlocks}u;
      let inputX = i32(tileX + pixel % ${haloWidth}u) - 1;
      let inputY = i32(tileY + pixel / ${haloWidth}u) - 1;
      if (block < ${inputBlocks}u && inputX >= 0 && inputY >= 0 &&
          inputX < i32(${imageWidth}) && inputY < i32(${imageHeight})) {
        ${sourceRead}
      }`
        )
      },
      {
        array: "weightTile",
        vectors: 9 * size * outputChannels / 4,
        read: (
          /* wgsl */
          `let quad = i % ${outputChannels / 4}u;
      let row = i / ${outputChannels / 4}u;
      let tap = row / ${size}u;
      let inputChannel = stageChunk * ${size}u + row % ${size}u;
      let outputBlock = blockBase + quad;
      if (inputChannel < ${inputBlocks * 4}u && outputBlock < ${outputBlocks}u) {
        value = weights[((tap * ${inputBlocks}u + inputChannel / 4u) * ${outputBlocks}u + outputBlock) * 4u + inputChannel % 4u];
      }`
        )
      }
    ], taps, threads, valueType, component, doubleBuffer)}

  ${epilogues.join("\n  ")}
}
`
  );
}
var SUBPIXEL_OFFSETS = [[-1, 0], [0, 1]];
var SUBPIXEL_TAPS = [[[0], [1, 2]], [[0, 1], [2]]];
var SUBPIXEL_MATRICES = 16;
function packSubpixelDecoderTensors(device, id, tensors, precision, sourceBlocks, upsampledSource) {
  const outputBlocks = blocksForChannels(tensors.outputChannels);
  const upBlocks = sourceBlocks[upsampledSource];
  const skipBlocks = sourceBlocks[1 - upsampledSource];
  const upBase = upsampledSource === 0 ? 0 : sourceBlocks[0] * 4;
  const skipBase = upsampledSource === 0 ? sourceBlocks[0] * 4 : 0;
  const upValues = SUBPIXEL_MATRICES * upBlocks * outputBlocks * 16;
  const values2 = new Float32Array(upValues + 9 * skipBlocks * outputBlocks * 16);
  const source = tensorFloat32Values(tensors.weight);
  const weight = (outputChannel, inputChannel, y, x) => outputChannel < tensors.outputChannels && inputChannel < tensors.inputChannels ? source[((outputChannel * tensors.inputChannels + inputChannel) * 3 + y) * 3 + x] : 0;
  for (let outputChannel = 0; outputChannel < outputBlocks * 4; outputChannel++) {
    const outputBlock = outputChannel >> 2;
    const outputLane = outputChannel & 3;
    for (let channel = 0; channel < upBlocks * 4; channel++) {
      for (let phase = 0; phase < 4; phase++) {
        for (let tap = 0; tap < 4; tap++) {
          let sum = 0;
          for (const y of SUBPIXEL_TAPS[phase >> 1][tap >> 1]) {
            for (const x of SUBPIXEL_TAPS[phase & 1][tap & 1]) {
              sum += weight(outputChannel, upBase + channel, y, x);
            }
          }
          const vector = ((phase * 4 + tap) * upBlocks + (channel >> 2)) * outputBlocks + outputBlock;
          values2[vector * 16 + (channel & 3) * 4 + outputLane] = sum;
        }
      }
    }
    for (let channel = 0; channel < skipBlocks * 4; channel++) {
      for (let tap = 0; tap < 9; tap++) {
        const vector = (tap * skipBlocks + (channel >> 2)) * outputBlocks + outputBlock;
        values2[upValues + vector * 16 + (channel & 3) * 4 + outputLane] = weight(outputChannel, skipBase + channel, tap / 3 | 0, tap % 3);
      }
    }
  }
  let bytes;
  if (precision === "fp16") {
    const half = new Uint16Array(values2.length);
    for (let index = 0; index < values2.length; index++)
      half[index] = numberToHalfBits(values2[index]);
    bytes = new Uint8Array(half.buffer);
  } else {
    bytes = new Uint8Array(values2.buffer);
  }
  const packedBias = new Float32Array(outputBlocks * 4);
  packedBias.set(tensorFloat32Values(tensors.bias));
  const weights = createMappedBuffer(device, `oidn/${id}/weights/${precision}/subpixel`, bytes, BufferUsage.STORAGE);
  try {
    return {
      weights,
      weightLayout: "k-major",
      bias: createMappedBuffer(device, `oidn/${id}/bias`, new Uint8Array(packedBias.buffer), BufferUsage.STORAGE)
    };
  } catch (error) {
    weights.destroy();
    throw error;
  }
}
function createSubgroupMatrixSubpixelShader(precision, outputPrecision, activation2, outputBlocks, config, outputFragments, sourceBlocks, upsampledSource, doubleBuffer) {
  const size = config.size;
  const buffers = doubleBuffer ? 2 : 1;
  const component = config.componentType;
  const result = config.resultType;
  const tileWidth = SUBGROUP_MATRIX_TILE_WIDTH;
  const tileHeight = SUBGROUP_MATRIX_TILE_HEIGHT;
  const haloWidth = tileWidth + 2;
  const haloRows = tileHeight + 2;
  const upWidth = tileWidth / 2 + 2;
  const upRows = tileHeight / 2 + 2;
  const chunkBlocks = size / 4;
  const upBlocks = sourceBlocks[upsampledSource];
  const skipBlocks = sourceBlocks[1 - upsampledSource];
  const upChunks = Math.ceil(upBlocks / chunkBlocks);
  const skipChunks = Math.ceil(skipBlocks / chunkBlocks);
  const outputChannels = outputFragments * size;
  const rows = tileHeight / 2;
  const segments = tileWidth / 2 / size;
  const threads = SUBGROUP_MATRIX_SUBGROUPS * config.subgroupSize;
  const valueType = storageVecType2(precision);
  const outputType = storageVecType2(outputPrecision);
  const { left, right, load, store, multiplyAdd, declare, extensions } = subgroupMatrixDialect(config);
  const accumulator = (row, segment, fragment) => `acc${row}_${segment}_${fragment}`;
  const declarations = [];
  for (let row = 0; row < rows; row++) {
    for (let segment = 0; segment < segments; segment++) {
      for (let fragment = 0; fragment < outputFragments; fragment++) {
        declarations.push(declare(accumulator(row, segment, fragment)));
      }
    }
  }
  const multiplyRows = (aOffset, stride) => {
    const lines = [];
    for (let row = 0; row < rows; row++) {
      for (let segment = 0; segment < segments; segment++) {
        lines.push(`{
        let a = ${load(left, "inputTile", `inputTileBase + ${aOffset(row, segment)}`, stride)};
        ${Array.from({ length: outputFragments }, (_, fragment) => `${accumulator(row, segment, fragment)} = ${multiplyAdd}(a, b${fragment}, ${accumulator(row, segment, fragment)});`).join("\n        ")}
      }`);
      }
    }
    return lines.join("\n      ");
  };
  const rightLoads = (matrix) => Array.from({ length: outputFragments }, (_, fragment) => `let b${fragment} = ${load(right, "weightTile", `weightTileBase + ${matrix} * ${size * outputChannels}u + ${fragment * size}u`, `${outputChannels}u`)};`).join("\n      ");
  const sourceIndex = (source, x, y) => `(${y} * params.source${source}Width + ${x}) * ${sourceBlocks[source]}u`;
  const inputVectors = Math.max(haloRows * haloWidth, upRows * upWidth) * chunkBlocks;
  const weightVectors = SUBPIXEL_MATRICES * size * outputChannels / 4;
  const weightStage = (matrices, blocks, base) => ({
    array: "weightTile",
    vectors: matrices * size * outputChannels / 4,
    stride: weightVectors,
    read: (
      /* wgsl */
      `let quad = i % ${outputChannels / 4}u;
      let row = i / ${outputChannels / 4}u;
      let matrix = row / ${size}u;
      let inputChannel = stageChunk * ${size}u + row % ${size}u;
      let outputBlock = blockBase + quad;
      if (inputChannel < ${blocks * 4}u && outputBlock < ${outputBlocks}u) {
        value = weights[${base}u + ((matrix * ${blocks}u + inputChannel / 4u) * ${outputBlocks}u + outputBlock) * 4u + inputChannel % 4u];
      }`
    )
  });
  const inputStage = (rowsStaged, width, read) => ({
    array: "inputTile",
    vectors: rowsStaged * width * chunkBlocks,
    stride: inputVectors,
    read: (
      /* wgsl */
      `let pixel = i / ${chunkBlocks}u;
      let block = stageChunk * ${chunkBlocks}u + i % ${chunkBlocks}u;
      ${read}`
    )
  });
  const upRead = (
    /* wgsl */
    `let inputX = i32(tileX / 2u + pixel % ${upWidth}u) - 1;
      let inputY = i32(tileY / 2u + pixel / ${upWidth}u) - 1;
      if (block < ${upBlocks}u && inputX >= 0 && inputY >= 0 &&
          inputX < i32(params.source${upsampledSource}Width) && inputY < i32(params.source${upsampledSource}Height)) {
        value = input${upsampledSource}[${sourceIndex(upsampledSource, "u32(inputX)", "u32(inputY)")} + block];
      }`
  );
  const skipSource = 1 - upsampledSource;
  const skipRead = (
    /* wgsl */
    `let inputX = i32(tileX + pixel % ${haloWidth}u) - 1;
      let inputY = i32(tileY + pixel / ${haloWidth}u) - 1;
      if (block < ${skipBlocks}u && inputX >= 0 && inputY >= 0 &&
          inputX < i32(params.outputWidth) && inputY < i32(params.outputHeight)) {
        value = input${skipSource}[${sourceIndex(skipSource, "u32(inputX)", "u32(inputY)")} + block];
      }`
  );
  const upMultiplies = [];
  for (let tapY = 0; tapY < 2; tapY++) {
    for (let tapX = 0; tapX < 2; tapX++) {
      upMultiplies.push(`{
      let matrix = phase * 4u + ${tapY * 2 + tapX}u;
      let offsetY = select(${SUBPIXEL_OFFSETS[0][tapY] + 1}u, ${SUBPIXEL_OFFSETS[1][tapY] + 1}u, phaseY == 1u);
      let offsetX = select(${SUBPIXEL_OFFSETS[0][tapX] + 1}u, ${SUBPIXEL_OFFSETS[1][tapX] + 1}u, phaseX == 1u);
      ${rightLoads("matrix")}
      ${multiplyRows((row, segment) => `((${row}u + offsetY) * ${upWidth}u + ${segment * size}u + offsetX) * ${size}u`, `${size}u`)}
    }`);
    }
  }
  const skipTapBody = `let ky = tap / 3u;
      let kx = tap % 3u;
      ${rightLoads("tap")}
      ${multiplyRows((row, segment) => `((phaseY + ${row * 2}u + ky) * ${haloWidth}u + phaseX + kx + ${segment * size * 2}u) * ${size}u`, `${size * 2}u`)}`;
  const skipTaps = subgroupMatrixTapLoop(config, skipTapBody);
  const epilogues = [];
  for (let row = 0; row < rows; row++) {
    for (let fragment = 0; fragment < outputFragments; fragment++) {
      epilogues.push(`{
    ${Array.from({ length: segments }, (_, segment) => store("resultTile", `resultBase + ${segment * size * size}u`, accumulator(row, segment, fragment), `${size}u`)).join("\n    ")}
    workgroupBarrier();
    let outputY = tileY + phaseY + ${row * 2}u;
    for (var e = lane; e < ${tileWidth / 2 * chunkBlocks}u; e += ${config.subgroupSize}u) {
      let pixel = e / ${chunkBlocks}u;
      let outputX = tileX + phaseX + pixel * 2u;
      let outputBlock = blockBase + ${fragment * chunkBlocks}u + e % ${chunkBlocks}u;
      if (outputX < params.outputWidth && outputY < params.outputHeight && outputBlock < ${outputBlocks}u) {
        let base = resultBase + pixel * ${size}u + (e % ${chunkBlocks}u) * 4u;
        let acc = vec4<f32>(f32(resultTile[base]), f32(resultTile[base + 1u]),
          f32(resultTile[base + 2u]), f32(resultTile[base + 3u])) + bias[outputBlock];
        outputData[(outputY * params.outputWidth + outputX) * ${outputBlocks}u + outputBlock] = ${storeExpression(activationExpression("acc", activation2), outputPrecision)};
      }
    }
    workgroupBarrier();
  }`);
    }
  }
  const needsF16 = precision === "fp16" || outputPrecision === "fp16" || component === "f16" || result === "f16";
  return (
    /* wgsl */
    `${needsF16 ? "enable f16;\n" : ""}${extensions}
struct Params {
  outputWidth: u32,
  outputHeight: u32,
  outputBlocks: u32,
  inputBlocks: u32,
  source0Width: u32,
  source0Height: u32,
  source1Width: u32,
  source1Height: u32,
}
@group(0) @binding(0) var<storage, read> input0: array<${valueType}>;
@group(0) @binding(1) var<storage, read> input1: array<${valueType}>;
@group(0) @binding(2) var<storage, read> weights: array<${valueType}>;
@group(0) @binding(3) var<storage, read> bias: array<vec4<f32>>;
@group(0) @binding(4) var<storage, read_write> outputData: array<${outputType}>;
@group(0) @binding(5) var<uniform> params: Params;

var<workgroup> inputTile: array<${component}, ${buffers * inputVectors * 4}>;
var<workgroup> weightTile: array<${component}, ${buffers * weightVectors * 4}>;
var<workgroup> resultTile: array<${result}, ${SUBGROUP_MATRIX_SUBGROUPS * (tileWidth / 2) * size}>;

@compute @workgroup_size(${threads})
fn main(
  @builtin(local_invocation_index) localIndex: u32,
  @builtin(workgroup_id) workgroupId: vec3<u32>,
  @builtin(subgroup_id) subgroup: u32,
  @builtin(subgroup_invocation_id) lane: u32
) {
  let tileX = workgroupId.x * ${tileWidth}u;
  let tileY = workgroupId.y * ${tileHeight}u;
  let blockBase = workgroupId.z * ${outputChannels / 4}u;
  let phase = subgroup;
  let phaseY = subgroup >> 1u;
  let phaseX = subgroup & 1u;
  let resultBase = subgroup * ${tileWidth / 2 * size}u;
  ${declarations.join("\n  ")}

  ${subgroupMatrixChunkLoop(upChunks, [inputStage(upRows, upWidth, upRead), weightStage(SUBPIXEL_MATRICES, upBlocks, 0)], upMultiplies.join("\n    "), threads, valueType, component, doubleBuffer)}

  ${subgroupMatrixChunkLoop(skipChunks, [
      inputStage(haloRows, haloWidth, skipRead),
      weightStage(9, skipBlocks, SUBPIXEL_MATRICES * upBlocks * outputBlocks * 4)
    ], skipTaps, threads, valueType, component, doubleBuffer)}

  ${epilogues.join("\n  ")}
}
`
  );
}
function executableInputs2(node) {
  if (node.op === "concat")
    return node.inputs;
  if (node.op === "fusedUpsampleConcatConv2d") {
    return node.inputs.map((input) => input.value);
  }
  return [node.input];
}
function resolveNativeUNetPrecision(device, requested = "auto") {
  const hasShaderF16 = device.features.has("shader-f16");
  if (requested === "fp16" && !hasShaderF16) {
    throw new Error("OIDN FP16 was requested but the OIDNGPUDevice does not have shader-f16 enabled");
  }
  if (requested === "auto")
    return hasShaderF16 ? "fp16" : "fp32";
  return requested;
}
var NativeUNetCore = class {
  _device;
  usedKernels = /* @__PURE__ */ new Set();
  /** Immutable packed weights and biases, for native resource sharing. */
  get weightBuffers() {
    return [...this._packedConvs.values()].flatMap((packed) => [packed.weights, packed.bias]);
  }
  precision;
  kernelSetting;
  gemm;
  maxSpatialInputBlocks;
  subgroupsAvailable;
  /** Selected configuration when the `subgroup-matrix` kernel can run. */
  subgroupMatrix;
  subgroupMatrixOutputFragments;
  subgroupMatrixSubPixel;
  subgroupMatrixDoubleBuffer;
  _subgroupMatrixFixedFragments;
  _model;
  _gemmByOutputBlocks = /* @__PURE__ */ new Map();
  _packedConvs = /* @__PURE__ */ new Map();
  _pipelineCache;
  _executionCache = /* @__PURE__ */ new Map();
  _retiredExecutions = /* @__PURE__ */ new Set();
  _clock = 0;
  _shapeCacheSize;
  _profileNextExecution = false;
  _profileOperations = 0;
  _resources = new OIDNResourceTracker();
  _disposed = false;
  constructor(_device, model, options = {}) {
    this._device = _device;
    this._pipelineCache = sharedPipelineCache(_device);
    this.precision = resolveNativeUNetPrecision(_device, options.precision ?? "auto");
    this.kernelSetting = options.kernel ?? "auto";
    const workgroupSize = options.gemm?.workgroupSize ?? [8, 8];
    this.gemm = Object.freeze({
      tilePolicy: options.gemm?.tilePolicy ?? (options.gemm?.workgroupSize ? "fixed" : "output-aligned"),
      decoderLoad: options.gemm?.decoderLoad ?? "per-load",
      decoderSubPixel: options.gemm?.decoderSubPixel ?? this.precision === "fp16",
      unrollRows: options.gemm?.unrollRows ?? false,
      poolLayout: options.gemm?.poolLayout ?? "channels",
      sharedLayout: options.gemm?.sharedLayout ?? (this.precision === "fp16" ? "padded-input" : "padded"),
      accumulationOrder: options.gemm?.accumulationOrder ?? "k-major",
      finalLayer: options.gemm?.finalLayer ?? "shared-auto",
      loadMode: options.gemm?.loadMode ?? "native",
      addressMode: options.gemm?.addressMode ?? "incremental",
      weightLayout: options.gemm?.weightLayout ?? "k-major",
      rowsPerThread: options.gemm?.rowsPerThread ?? 8,
      workgroupSize: Object.freeze([workgroupSize[0], workgroupSize[1]])
    });
    if (!["fixed", "output-aligned"].includes(this.gemm.tilePolicy)) {
      throw new Error(`Unsupported GEMM tile policy: ${this.gemm.tilePolicy}`);
    }
    if (!["per-load", "source-first"].includes(this.gemm.decoderLoad)) {
      throw new Error(`Unsupported GEMM decoder load: ${this.gemm.decoderLoad}`);
    }
    if (!["spatial", "channels"].includes(this.gemm.poolLayout)) {
      throw new Error(`Unsupported GEMM pool layout: ${this.gemm.poolLayout}`);
    }
    if (!["linear", "padded", "padded-input", "padded-weights"].includes(this.gemm.sharedLayout)) {
      throw new Error(`Unsupported GEMM shared layout: ${this.gemm.sharedLayout}`);
    }
    if (!["k-major", "row-major"].includes(this.gemm.accumulationOrder)) {
      throw new Error(`Unsupported GEMM accumulation order: ${this.gemm.accumulationOrder}`);
    }
    if (!["direct", "shared-input", "shared-input-weights", "shared-auto"].includes(this.gemm.finalLayer)) {
      throw new Error(`Unsupported GEMM final layer: ${this.gemm.finalLayer}`);
    }
    if (!["native", "packed-weights", "packed-all"].includes(this.gemm.loadMode)) {
      throw new Error(`Unsupported GEMM load mode: ${this.gemm.loadMode}`);
    }
    if (!["analytic", "incremental", "base-offset"].includes(this.gemm.addressMode)) {
      throw new Error(`Unsupported GEMM address mode: ${this.gemm.addressMode}`);
    }
    if (!["output-major", "k-major"].includes(this.gemm.weightLayout)) {
      throw new Error(`Unsupported GEMM weight layout: ${this.gemm.weightLayout}`);
    }
    const tile = gemmTile(this.gemm);
    const tileStorageBytes = (gemmSharedSizes(this.gemm).input + gemmSharedSizes(this.gemm).weights) * 4 * (this.precision === "fp16" ? 2 : 4);
    if (![2, 4, 8].includes(tile.rowsPerThread) || ![4, 8, 16].includes(tile.workgroupX) || ![4, 8].includes(tile.workgroupY) || workgroupSize.length !== 2 || tile.workgroupX > _device.limits.maxComputeWorkgroupSizeX || tile.workgroupY > _device.limits.maxComputeWorkgroupSizeY || tile.workgroupX * tile.workgroupY > _device.limits.maxComputeInvocationsPerWorkgroup || tileStorageBytes > _device.limits.maxComputeWorkgroupStorageSize) {
      throw new Error("Unsupported GEMM tile configuration for this OIDNGPUDevice");
    }
    this.subgroupsAvailable = _device.features.has("subgroups");
    const matrixOptions = options.subgroupMatrix ?? {};
    const matrixConfig = this.kernelSetting === "subgroup-matrix" ? selectSubgroupMatrixConfig(_device, matrixOptions.accumulation) : void 0;
    this.subgroupMatrixOutputFragments = matrixConfig ? subgroupMatrixFragments(matrixConfig, matrixOptions) : 0;
    this.subgroupMatrixSubPixel = matrixOptions.subPixel ?? true;
    this._subgroupMatrixFixedFragments = matrixOptions.outputFragments !== void 0;
    const fitsSharedMemory = (doubleBuffer) => matrixConfig !== void 0 && subgroupMatrixSharedBytes(matrixConfig, this.subgroupMatrixOutputFragments, this.subgroupMatrixSubPixel, doubleBuffer) <= _device.limits.maxComputeWorkgroupStorageSize;
    if (matrixConfig && matrixOptions.outputFragments === void 0 && !fitsSharedMemory(false)) {
      this.subgroupMatrixOutputFragments = 1;
    }
    this.subgroupMatrixDoubleBuffer = (matrixOptions.doubleBuffer ?? false) && fitsSharedMemory(true);
    if (matrixConfig && SUBGROUP_MATRIX_SUBGROUPS * matrixConfig.subgroupSize <= _device.limits.maxComputeInvocationsPerWorkgroup && SUBGROUP_MATRIX_SUBGROUPS * matrixConfig.subgroupSize <= _device.limits.maxComputeWorkgroupSizeX && fitsSharedMemory(this.subgroupMatrixDoubleBuffer)) {
      this.subgroupMatrix = matrixConfig;
    }
    this.maxSpatialInputBlocks = this.precision === "fp16" && _device.limits.maxComputeInvocationsPerWorkgroup >= SPATIAL_CONV_WORKGROUP * SPATIAL_CONV_WORKGROUP && _device.limits.maxComputeWorkgroupSizeX >= SPATIAL_CONV_WORKGROUP && _device.limits.maxComputeWorkgroupSizeY >= SPATIAL_CONV_WORKGROUP ? Math.floor(_device.limits.maxComputeWorkgroupStorageSize / (SPATIAL_CONV_PATCH * SPATIAL_CONV_PATCH * 4 * 2)) : 0;
    this._shapeCacheSize = Math.max(1, options.shapeCacheSize ?? 2);
    if (model.inputChannels % 3 !== 0 || model.inputChannels < 3 || model.inputChannels > 9) {
      throw new Error(`Native OIDN expects 3, 6, or 9 input channels, got ${model.inputChannels}`);
    }
    this._model = {
      spec: model.spec,
      inputChannels: model.inputChannels,
      outputChannels: model.outputChannels,
      channelsByValue: new Map(model.channelsByValue),
      convChannels: new Map(model.convChannels)
    };
    const subPixelDecoders = /* @__PURE__ */ new Map();
    for (const node of optimizeModelGraph(this._model, {
      fuseConvPool: this._matrixPool()
    }).nodes) {
      if (node.op === "fusedUpsampleConcatConv2d") {
        const decoder = this._subPixelDecoder(node);
        if (decoder)
          subPixelDecoders.set(node.conv.id, decoder);
      }
      if (node.op !== "conv2d" && node.op !== "maxPool2d" && node.op !== "fusedConvReluMaxPool2d" && node.op !== "fusedUpsampleConcatConv2d") {
        throw new Error(`Native OIDN descriptor ${model.spec.id} leaves unsupported ${node.op} node ${node.id} after graph optimization`);
      }
    }
    try {
      for (const [id, tensors] of model.convTensors) {
        const kernel = this._selectConvKernel(blocksForChannels(tensors.inputChannels), id === model.spec.output);
        const weightLayout = kernel === "implicit-gemm" ? this.gemm.weightLayout : kernel === "subgroup-matrix" ? "k-major" : "output-major";
        const decoder = subPixelDecoders.get(id);
        const packed = decoder ? packSubpixelDecoderTensors(_device, id, tensors, this.precision, decoder.sourceBlocks, decoder.upsampledSource) : packConvTensors(_device, id, tensors, this.precision, weightLayout);
        this._resources.track("gpu-buffer", packed.weights);
        this._resources.track("gpu-buffer", packed.bias);
        this._packedConvs.set(id, packed);
      }
    } catch (error) {
      for (const packed of this._packedConvs.values()) {
        this._releaseBuffer(packed.weights);
        this._releaseBuffer(packed.bias);
      }
      this._packedConvs.clear();
      throw error;
    }
  }
  _pipeline(key, code) {
    let pipeline = this._pipelineCache.get(key);
    if (!pipeline) {
      pipeline = this._device.createComputePipeline({
        label: `oidn/${key}`,
        layout: "auto",
        compute: {
          module: this._device.createShaderModule({
            label: `oidn/${key}`,
            code
          }),
          entryPoint: "main"
        }
      });
      this._pipelineCache.set(key, pipeline);
    }
    return pipeline;
  }
  _nodePipelineSpec(node, isFinal, fragments = this.subgroupMatrixOutputFragments) {
    if (node.op === "conv2d") {
      const outputPrecision = isFinal ? "fp32" : this.precision;
      const inputBlocks = blocksForChannels(this._model.convChannels.get(node.id).inputChannels);
      const outputBlocks = blocksForChannels(this._model.convChannels.get(node.id).outputChannels);
      const gemm = this._gemmForOutput(outputBlocks);
      const kernel = this._selectConvKernel(inputBlocks, isFinal);
      const cacheFinalWeights = gemm.finalLayer === "shared-input-weights" || gemm.finalLayer === "shared-auto" && sharedMemoryBytes(this.precision, inputBlocks, true) <= this._device.limits.maxComputeWorkgroupStorageSize;
      if (kernel !== "subgroup-matrix" && isFinal && this._model.convChannels.get(node.id).outputChannels === 3 && (this.kernelSetting === "auto" || this.kernelSetting === "implicit-gemm" || this.kernelSetting === "subgroup-matrix") && gemm.finalLayer !== "direct" && this._device.limits.maxComputeWorkgroupSizeX >= 8 && this._device.limits.maxComputeWorkgroupSizeY >= 8 && this._device.limits.maxComputeInvocationsPerWorkgroup >= 64 && sharedMemoryBytes(this.precision, inputBlocks, cacheFinalWeights) <= this._device.limits.maxComputeWorkgroupStorageSize) {
        return {
          key: `conv-final-rgb/${this.precision}/${node.activation}/in${inputBlocks}/weights-${cacheFinalWeights ? "shared" : "storage"}`,
          kernel: "direct",
          code: createFinalRgbShader(this.precision, node.activation, inputBlocks, cacheFinalWeights)
        };
      }
      if (kernel === "subgroup-matrix") {
        return this._subgroupMatrixSpec(`conv/${node.activation}/in${inputBlocks}/out${outputBlocks}`, outputPrecision, node.activation, inputBlocks, outputBlocks, fragments);
      }
      const key = `conv-${kernel}/${this.precision}/${outputPrecision}/${node.activation}/in${inputBlocks}/out${outputBlocks}` + (kernel === "implicit-gemm" ? `/address-${gemm.addressMode}/weights-${gemm.weightLayout}-v1/tile-${gemm.workgroupSize.join("x")}-r${gemm.rowsPerThread}/loads-${gemm.loadMode}/shared-${gemm.sharedLayout}/acc-${gemm.accumulationOrder}/unroll-${Number(gemm.unrollRows)}` : "");
      return {
        key,
        kernel,
        code: kernel === "implicit-gemm" ? createTiledConvShader(this.precision, outputPrecision, node.activation, inputBlocks, outputBlocks, gemm) : kernel === "spatial" ? createSpatialConvShader(this.precision, outputPrecision, node.activation, inputBlocks, outputBlocks) : kernel === "subgroup" ? createSubgroupConvShader(this.precision, outputPrecision, node.activation, inputBlocks, outputBlocks) : createConvShader(this.precision, outputPrecision, node.activation, inputBlocks, outputBlocks)
      };
    }
    if (node.op === "maxPool2d") {
      const outputBlocks = blocksForChannels(this._model.channelsByValue.get(node.id));
      const coalesced = this._coalescedPool();
      const key = `max-pool/${this.precision}/out${outputBlocks}/${coalesced ? "channels" : "spatial"}`;
      return {
        key,
        kernel: "direct",
        code: createMaxPoolShader(this.precision, outputBlocks, coalesced)
      };
    }
    if (node.op === "fusedConvReluMaxPool2d") {
      const inputBlocks = blocksForChannels(this._model.convChannels.get(node.conv.id).inputChannels);
      const outputBlocks = blocksForChannels(this._model.convChannels.get(node.conv.id).outputChannels);
      if (this._matrixPool()) {
        return this._subgroupMatrixSpec(`conv-pool/${node.conv.activation}/in${inputBlocks}/out${outputBlocks}`, this.precision, node.conv.activation, inputBlocks, outputBlocks, fragments, void 0, true);
      }
      const key = `conv-pool/${this.precision}/${node.conv.activation}/in${inputBlocks}/out${outputBlocks}`;
      return {
        key,
        kernel: "direct",
        code: createFusedConvPoolShader(this.precision, node.conv.activation, inputBlocks, outputBlocks)
      };
    }
    if (node.op === "fusedUpsampleConcatConv2d") {
      if (node.inputs.length !== 2) {
        throw new Error(`Native fused decoder ${node.id} requires two inputs`);
      }
      const sourceBlocks = node.inputs.map((input) => blocksForChannels(this._model.channelsByValue.get(input.value)));
      const upsampledSource = node.inputs.findIndex((input) => input.upsample);
      if (upsampledSource !== 0 && upsampledSource !== 1) {
        throw new Error(`Native fused decoder ${node.id} has no upsample input`);
      }
      const inputBlocks = sourceBlocks[0] + sourceBlocks[1];
      const outputPrecision = isFinal ? "fp32" : this.precision;
      const selectedKernel = this._selectConvKernel(inputBlocks, isFinal);
      const kernel = selectedKernel === "subgroup" ? "direct" : selectedKernel;
      const outputBlocks = blocksForChannels(this._model.convChannels.get(node.conv.id).outputChannels);
      if (kernel === "subgroup-matrix" && this._subPixelDecoder(node)) {
        const config = this.subgroupMatrix;
        return {
          key: `subgroup-matrix-subpixel/${this.precision}/${outputPrecision}/${config.dialect}/${config.componentType}-${config.resultType}-${config.size}-sg${config.subgroupSize}/n${fragments}${this.subgroupMatrixDoubleBuffer ? "-db" : ""}/${node.conv.activation}/${sourceBlocks.join("+")}/out${outputBlocks}/up${upsampledSource}`,
          kernel: "subgroup-matrix",
          code: createSubgroupMatrixSubpixelShader(this.precision, outputPrecision, node.conv.activation, outputBlocks, config, fragments, sourceBlocks, upsampledSource, this.subgroupMatrixDoubleBuffer)
        };
      }
      if (kernel === "subgroup-matrix") {
        return this._subgroupMatrixSpec(`decoder/${node.conv.activation}/${sourceBlocks.join("+")}/out${outputBlocks}/up${upsampledSource}`, outputPrecision, node.conv.activation, inputBlocks, outputBlocks, fragments, { sourceBlocks, upsampledSource });
      }
      const gemm = this._gemmForOutput(outputBlocks);
      const key = `decoder-${kernel}${kernel === "implicit-gemm" && this._subPixelDecoder(node) ? "-subpixel" : ""}/${this.precision}/${outputPrecision}/${node.conv.activation}/${sourceBlocks.join("+")}/out${outputBlocks}/up${upsampledSource}` + (kernel === "implicit-gemm" ? `/address-${gemm.addressMode}/weights-${gemm.weightLayout}-v1/tile-${gemm.workgroupSize.join("x")}-r${gemm.rowsPerThread}/loads-${gemm.loadMode}/shared-${gemm.sharedLayout}/acc-${gemm.accumulationOrder}/unroll-${Number(gemm.unrollRows)}/decoder-${gemm.decoderLoad}` : "");
      return {
        key,
        kernel,
        code: kernel === "implicit-gemm" ? (this._subPixelDecoder(node) ? createTiledSubpixelDecoderShader : createTiledDecoderShader)(this.precision, outputPrecision, node.conv.activation, sourceBlocks, upsampledSource, outputBlocks, gemm) : kernel === "spatial" ? createSpatialDecoderShader(this.precision, outputPrecision, node.conv.activation, sourceBlocks, upsampledSource, outputBlocks) : createFusedDecoderShader(this.precision, outputPrecision, node.conv.activation, sourceBlocks, upsampledSource, outputBlocks)
      };
    }
    throw new Error(`Native OIDN does not implement unfused ${node.op} node ${node.id}`);
  }
  /** The decoder's sources when it runs with the sub-pixel decomposition. */
  _subPixelDecoder(node) {
    if (node.id === this._model.spec.output || node.inputs.length !== 2) {
      return void 0;
    }
    const kernel = this._selectConvKernel(blocksForChannels(this._model.convChannels.get(node.conv.id).inputChannels), false);
    if (!(kernel === "subgroup-matrix" && this.subgroupMatrixSubPixel) && !(kernel === "implicit-gemm" && this.gemm.decoderSubPixel && this.gemm.weightLayout === "k-major")) {
      return void 0;
    }
    const upsampledSource = node.inputs[0].upsample ? 0 : node.inputs[1].upsample ? 1 : -1;
    if (upsampledSource === -1)
      return void 0;
    return {
      sourceBlocks: node.inputs.map((input) => blocksForChannels(this._model.channelsByValue.get(input.value))),
      upsampledSource
    };
  }
  _subgroupMatrixSpec(key, outputPrecision, activation2, inputBlocks, outputBlocks, fragments, decoder, pool2 = false) {
    const config = this.subgroupMatrix;
    return {
      key: `subgroup-matrix/${this.precision}/${outputPrecision}/${config.dialect}/${config.componentType}-${config.resultType}-${config.size}-sg${config.subgroupSize}/n${fragments}${this.subgroupMatrixDoubleBuffer ? "-db" : ""}/${key}`,
      kernel: "subgroup-matrix",
      code: createSubgroupMatrixConvShader(this.precision, outputPrecision, activation2, inputBlocks, outputBlocks, config, fragments, this.subgroupMatrixDoubleBuffer, decoder, pool2)
    };
  }
  /**
   * Output fragments per workgroup for a subgroup-matrix layer: the default
   * unless that leaves fewer than SUBGROUP_MATRIX_MIN_WORKGROUPS workgroups,
   * where one fragment keeps more of the GPU busy (low-resolution layers).
   * Never more fragments than the output channels fill (the final RGB layer).
   */
  _subgroupMatrixFragmentsFor(shape) {
    const fragments = Math.min(this.subgroupMatrixOutputFragments, Math.ceil(blocksForChannels(shape.channels) * 4 / this.subgroupMatrix.size));
    if (this._subgroupMatrixFixedFragments || fragments === 1)
      return fragments;
    const workgroups = Math.ceil(shape.width / SUBGROUP_MATRIX_TILE_WIDTH) * Math.ceil(shape.height / SUBGROUP_MATRIX_TILE_HEIGHT) * Math.ceil(blocksForChannels(shape.channels) * 4 / (fragments * this.subgroupMatrix.size));
    return workgroups < SUBGROUP_MATRIX_MIN_WORKGROUPS ? 1 : fragments;
  }
  // Wider output tiles reuse each input load across twice as many channels.
  // Require full output blocks and keep the validated base tile as fallback.
  _gemmForOutput(outputBlocks) {
    if (this.gemm.tilePolicy !== "output-aligned" || this.gemm.workgroupSize[0] !== 8 || outputBlocks <= 0 || outputBlocks % 16 !== 0) {
      return this.gemm;
    }
    const cached = this._gemmByOutputBlocks.get(outputBlocks);
    if (cached)
      return cached;
    const candidate = Object.freeze({
      ...this.gemm,
      workgroupSize: Object.freeze([16, this.gemm.workgroupSize[1]])
    });
    const tile = gemmTile(candidate);
    const sizes = gemmSharedSizes(candidate);
    const limits = this._device.limits;
    const fits = tile.workgroupX <= limits.maxComputeWorkgroupSizeX && tile.workgroupY <= limits.maxComputeWorkgroupSizeY && tile.workgroupX * tile.workgroupY <= limits.maxComputeInvocationsPerWorkgroup && (sizes.input + sizes.weights) * 4 * (this.precision === "fp16" ? 2 : 4) <= limits.maxComputeWorkgroupStorageSize;
    const selected = fits ? candidate : this.gemm;
    this._gemmByOutputBlocks.set(outputBlocks, selected);
    return selected;
  }
  // Keep fusion on the Large native 8x8 mixed-precision configuration measured
  // on Metal. Other matrix shapes and browser kernels retain separate pooling.
  _matrixPool() {
    const config = this.subgroupMatrix;
    return this._model.spec.family === "oidn-unet-large" && this.precision === "fp16" && config?.dialect === "naga" && config.size === 8 && config.subgroupSize === 32 && config.componentType === "f16" && config.resultType === "f32";
  }
  _coalescedPool() {
    return this.gemm.poolLayout === "channels" && (this.kernelSetting === "auto" || this.kernelSetting === "implicit-gemm" || this.kernelSetting === "subgroup-matrix");
  }
  _selectConvKernel(inputBlocks, isFinal) {
    const spatialFits = this.precision === "fp16" && inputBlocks <= this.maxSpatialInputBlocks;
    if (this.kernelSetting === "direct")
      return "direct";
    if (this.kernelSetting === "spatial") {
      return spatialFits ? "spatial" : "direct";
    }
    if (this.kernelSetting === "implicit-gemm") {
      return isFinal ? "direct" : "implicit-gemm";
    }
    if (this.kernelSetting === "subgroup") {
      return this.subgroupsAvailable ? "subgroup" : "direct";
    }
    if (this.kernelSetting === "subgroup-matrix") {
      if (isFinal)
        return this.subgroupMatrix?.dialect === "naga" ? "subgroup-matrix" : "direct";
      return this.subgroupMatrix ? "subgroup-matrix" : "implicit-gemm";
    }
    if (!isFinal)
      return "implicit-gemm";
    return "direct";
  }
  _nodePipeline(node, isFinal) {
    const { key, code } = this._nodePipelineSpec(node, isFinal);
    return this._pipeline(key, code);
  }
  _createExecution(width, height) {
    const fuseConvPool = this._matrixPool();
    const plan = planModelExecution(this._model, width, height, { fuseConvPool });
    const valueBuffers = /* @__PURE__ */ new Map();
    const slots = [];
    const plannedSlots = [];
    const lastUses = /* @__PURE__ */ new Map();
    plan.nodes.forEach((node, index) => {
      for (const input of executableInputs2(node))
        lastUses.set(input, index);
    });
    lastUses.set(plan.spec.output, plan.nodes.length);
    const createdBuffers = [];
    const own = (buffer2) => {
      createdBuffers.push(buffer2);
      return this._resources.track("gpu-buffer", buffer2);
    };
    try {
      const allocate = (value, shape, bytesPerScalar, index) => {
        const requiredSize = activationByteSize(shape, bytesPerScalar);
        const free = plannedSlots.filter((slot2) => slot2.lastUse < index);
        let slot = free.filter((candidate) => candidate.capacity >= requiredSize).sort((a2, b2) => a2.capacity - b2.capacity)[0];
        if (!slot && fuseConvPool)
          slot = free.sort((a2, b2) => b2.capacity - a2.capacity)[0];
        if (!slot) {
          slot = { capacity: 0, lastUse: -2, values: [] };
          plannedSlots.push(slot);
        }
        slot.capacity = Math.max(slot.capacity, requiredSize);
        slot.lastUse = lastUses.get(value) ?? -1;
        slot.values.push(value);
      };
      allocate(plan.spec.input, plan.inputShape, this.precision === "fp16" ? 2 : 4, -1);
      plan.plannedNodes.forEach(({ node, outputShape }, index) => {
        const isFinal = node.id === plan.spec.output;
        allocate(node.id, outputShape, isFinal || this.precision === "fp32" ? 4 : 2, index);
      });
      plannedSlots.forEach((slot, index) => {
        const buffer2 = own(this._device.createBuffer({
          label: `oidn/activation/${width}x${height}/${index}`,
          size: roundUp(slot.capacity, 4),
          usage: BufferUsage.STORAGE | BufferUsage.COPY_SRC | BufferUsage.COPY_DST
        }));
        slots.push({ buffer: buffer2, capacity: slot.capacity });
        for (const value of slot.values)
          valueBuffers.set(value, buffer2);
      });
      const inputSourceCount = this._model.inputChannels / 3;
      const inputKey = `pack/${this.precision}/${inputSourceCount}`;
      const inputPipeline = this._pipeline(inputKey, createInputPackShader(this.precision, inputSourceCount));
      const nodePipelines = [];
      const nodeKernels = [];
      const nodeFragments = [];
      const nodeBindings = [];
      const ownedBuffers = [];
      plan.plannedNodes.forEach(({ node, outputShape }, index) => {
        const isFinal = node.id === plan.spec.output;
        const fragments = this.subgroupMatrix ? this._subgroupMatrixFragmentsFor(outputShape) : 0;
        const pipelineSpec = this._nodePipelineSpec(node, isFinal, fragments);
        if (pipelineSpec.kernel)
          this.usedKernels.add(pipelineSpec.kernel);
        const pipeline = this._pipeline(pipelineSpec.key, pipelineSpec.code);
        nodePipelines.push(pipeline);
        nodeKernels.push(pipelineSpec.kernel ?? "direct");
        nodeFragments.push(pipelineSpec.kernel === "subgroup-matrix" ? fragments : 0);
        const output = valueBuffers.get(node.id);
        let entries;
        let uniformValues;
        let convId;
        if (node.op === "conv2d") {
          const inputShape = plan.valueShapes.get(node.input);
          convId = node.id;
          uniformValues = [
            inputShape.width,
            inputShape.height,
            outputShape.width,
            outputShape.height,
            blocksForChannels(inputShape.channels),
            blocksForChannels(outputShape.channels)
          ];
          const packed = this._packedConvs.get(convId);
          entries = [
            { binding: 0, resource: { buffer: valueBuffers.get(node.input) } },
            { binding: 1, resource: { buffer: packed.weights } },
            { binding: 2, resource: { buffer: packed.bias } },
            { binding: 3, resource: { buffer: output } }
          ];
        } else if (node.op === "maxPool2d") {
          const inputShape = plan.valueShapes.get(node.input);
          uniformValues = [
            inputShape.width,
            inputShape.height,
            outputShape.width,
            outputShape.height,
            blocksForChannels(outputShape.channels)
          ];
          entries = [
            { binding: 0, resource: { buffer: valueBuffers.get(node.input) } },
            { binding: 1, resource: { buffer: output } }
          ];
        } else if (node.op === "fusedConvReluMaxPool2d") {
          const inputShape = plan.valueShapes.get(node.input);
          convId = node.conv.id;
          uniformValues = [
            inputShape.width,
            inputShape.height,
            outputShape.width,
            outputShape.height,
            blocksForChannels(inputShape.channels),
            blocksForChannels(outputShape.channels)
          ];
          const packed = this._packedConvs.get(convId);
          entries = [
            { binding: 0, resource: { buffer: valueBuffers.get(node.input) } },
            { binding: 1, resource: { buffer: packed.weights } },
            { binding: 2, resource: { buffer: packed.bias } },
            { binding: 3, resource: { buffer: output } }
          ];
        } else if (node.op === "fusedUpsampleConcatConv2d") {
          convId = node.conv.id;
          const firstShape = plan.valueShapes.get(node.inputs[0].value);
          const secondShape = plan.valueShapes.get(node.inputs[1].value);
          uniformValues = [
            outputShape.width,
            outputShape.height,
            blocksForChannels(outputShape.channels),
            blocksForChannels(this._model.convChannels.get(convId).inputChannels),
            firstShape.width,
            firstShape.height,
            secondShape.width,
            secondShape.height
          ];
          const packed = this._packedConvs.get(convId);
          entries = [
            {
              binding: 0,
              resource: { buffer: valueBuffers.get(node.inputs[0].value) }
            },
            {
              binding: 1,
              resource: { buffer: valueBuffers.get(node.inputs[1].value) }
            },
            { binding: 2, resource: { buffer: packed.weights } },
            { binding: 3, resource: { buffer: packed.bias } },
            { binding: 4, resource: { buffer: output } }
          ];
        } else {
          throw new Error(`Unexpected native node ${node.op}`);
        }
        const uniform = own(createUniformBuffer(this._device, `oidn/${node.id}/params/${width}x${height}`, uniformValues));
        ownedBuffers.push(uniform);
        entries.push({ binding: entries.length, resource: { buffer: uniform } });
        nodeBindings.push(this._device.createBindGroup({
          label: `oidn/${node.id}/bindings`,
          layout: pipeline.getBindGroupLayout(0),
          entries
        }));
      });
      const inputUniform = own(createUniformBuffer(this._device, `oidn/input/params/${width}x${height}`, [
        width,
        height,
        blocksForChannels(this._model.inputChannels),
        this._model.inputChannels
      ]));
      ownedBuffers.push(inputUniform);
      return {
        plan,
        valueBuffers,
        slots,
        nodeBindings,
        nodePipelines,
        nodeKernels,
        nodeFragments,
        inputPipeline,
        inputUniform,
        ownedBuffers,
        lastUsed: ++this._clock
      };
    } catch (error) {
      for (const buffer2 of createdBuffers)
        this._releaseBuffer(buffer2);
      throw error;
    }
  }
  _execution(width, height) {
    if (this._disposed)
      throw new Error("Native OIDN executor is disposed");
    const key = `${width}x${height}`;
    let execution = this._executionCache.get(key);
    if (!execution) {
      execution = this._createExecution(width, height);
      this._executionCache.set(key, execution);
      if (this._executionCache.size > this._shapeCacheSize) {
        const oldest = [...this._executionCache.entries()].filter(([candidateKey]) => candidateKey !== key).sort((a2, b2) => a2[1].lastUsed - b2[1].lastUsed)[0];
        if (oldest) {
          this._executionCache.delete(oldest[0]);
          this._retireExecution(oldest[1]);
        }
      }
    }
    execution.lastUsed = ++this._clock;
    return execution;
  }
  /**
   * Releases an evicted plan. The synchronous core destroys it at once; the
   * browser executor waits for the queue first.
   */
  _retireExecution(execution) {
    this._destroyExecution(execution);
  }
  /** Allocates shape-dependent execution resources before interactive use. */
  prewarm(shapes) {
    for (const shape of shapes) {
      this._execution(shape.width, shape.height);
    }
  }
  /** Captures per-pass GPU timestamps for the next execute call when supported. */
  profileNextExecution() {
    if (!this._device.features.has("timestamp-query"))
      return false;
    this._profileNextExecution = true;
    return true;
  }
  /** Shape-owned packed input; external preprocessing must write all lanes. */
  packedInputBuffer(width, height) {
    const execution = this._execution(width, height);
    return execution.valueBuffers.get(execution.plan.spec.input);
  }
  /** Executes after a preprocessing pass has filled packedInputBuffer. */
  executePacked(width, height) {
    return this._execute([], width, height, true);
  }
  execute(inputBuffers, width, height) {
    return this._execute(inputBuffers, width, height, false);
  }
  _execute(inputBuffers, width, height, packedInput) {
    const sourceCount = this._model.inputChannels / 3;
    if (!packedInput && inputBuffers.length !== sourceCount) {
      throw new Error(`Native OIDN expected ${sourceCount} input buffers, got ${inputBuffers.length}`);
    }
    const execution = this._execution(width, height);
    const profileLabels = [
      ...packedInput ? [] : ["input-pack"],
      ...execution.plan.nodes.map((node) => node.id)
    ];
    const shouldProfile = this._profileNextExecution && this._device.features.has("timestamp-query");
    this._profileNextExecution = false;
    const queryCount = profileLabels.length * 2;
    const querySet = shouldProfile ? this._resources.track("gpu-query-set", this._device.createQuerySet({ type: "timestamp", count: queryCount })) : void 0;
    const queryBufferSize = queryCount * 8;
    let queryResolveBuffer;
    let queryReadbackBuffer;
    try {
      queryResolveBuffer = shouldProfile ? this._resources.track("gpu-buffer", this._device.createBuffer({
        label: `oidn/profile/resolve/${width}x${height}`,
        size: queryBufferSize,
        usage: BufferUsage.QUERY_RESOLVE | BufferUsage.COPY_SRC
      })) : void 0;
      queryReadbackBuffer = shouldProfile ? this._resources.track("gpu-buffer", this._device.createBuffer({
        label: `oidn/profile/readback/${width}x${height}`,
        size: queryBufferSize,
        usage: BufferUsage.COPY_DST | BufferUsage.MAP_READ
      })) : void 0;
    } catch (error) {
      this._releaseBuffer(queryReadbackBuffer);
      this._releaseBuffer(queryResolveBuffer);
      this._releaseQuerySet(querySet);
      throw error;
    }
    const passDescriptor = (label, index) => ({
      label,
      ...querySet ? {
        timestampWrites: {
          querySet,
          beginningOfPassWriteIndex: index * 2,
          endOfPassWriteIndex: index * 2 + 1
        }
      } : {}
    });
    try {
      const encoder = this._device.createCommandEncoder({
        label: `oidn/native/${width}x${height}`
      });
      if (!packedInput) {
        const inputEntries = inputBuffers.map((buffer2, binding) => ({ binding, resource: { buffer: buffer2 } }));
        inputEntries.push({
          binding: sourceCount,
          resource: { buffer: execution.valueBuffers.get(execution.plan.spec.input) }
        });
        inputEntries.push({
          binding: sourceCount + 1,
          resource: { buffer: execution.inputUniform }
        });
        const inputBindings = this._device.createBindGroup({
          label: "oidn/input/bindings",
          layout: execution.inputPipeline.getBindGroupLayout(0),
          entries: inputEntries
        });
        const pass = encoder.beginComputePass(passDescriptor("oidn/input-pack", 0));
        pass.setPipeline(execution.inputPipeline);
        pass.setBindGroup(0, inputBindings);
        pass.dispatchWorkgroups(Math.ceil(width / WORKGROUP_SIZE3), Math.ceil(height / WORKGROUP_SIZE3), blocksForChannels(this._model.inputChannels));
        pass.end();
      }
      execution.plan.plannedNodes.forEach(({ node, outputShape }, index) => {
        const pass = encoder.beginComputePass(passDescriptor(`oidn/${execution.plan.nodes[index].id}`, index + (packedInput ? 0 : 1)));
        pass.setPipeline(execution.nodePipelines[index]);
        pass.setBindGroup(0, execution.nodeBindings[index]);
        if (node.op === "maxPool2d" && this._coalescedPool()) {
          const groupsX = Math.ceil(outputShape.width * blocksForChannels(outputShape.channels) / WORKGROUP_SIZE3);
          const maxGroups = this._device.limits.maxComputeWorkgroupsPerDimension;
          pass.dispatchWorkgroups(Math.min(groupsX, maxGroups), Math.ceil(outputShape.height / WORKGROUP_SIZE3), Math.ceil(groupsX / maxGroups));
        } else if (execution.nodeKernels[index] === "subgroup-matrix") {
          pass.dispatchWorkgroups(Math.ceil(outputShape.width * (node.op === "fusedConvReluMaxPool2d" ? 2 : 1) / SUBGROUP_MATRIX_TILE_WIDTH), Math.ceil(outputShape.height * (node.op === "fusedConvReluMaxPool2d" ? 2 : 1) / SUBGROUP_MATRIX_TILE_HEIGHT), Math.ceil(blocksForChannels(outputShape.channels) / (execution.nodeFragments[index] * this.subgroupMatrix.size / 4)));
        } else if (execution.nodeKernels[index] === "implicit-gemm") {
          const tile = gemmTile(this._gemmForOutput(blocksForChannels(outputShape.channels)));
          const subPixel = node.op === "fusedUpsampleConcatConv2d" && this._subPixelDecoder(node) !== void 0;
          pass.dispatchWorkgroups(Math.ceil((subPixel ? Math.ceil(outputShape.width / 2) * Math.ceil(outputShape.height / 2) : outputShape.width * outputShape.height) / tile.tileM), Math.ceil(blocksForChannels(outputShape.channels) / tile.tileNBlocks), subPixel ? 4 : 1);
        } else {
          pass.dispatchWorkgroups(Math.ceil(outputShape.width / WORKGROUP_SIZE3), Math.ceil(outputShape.height / WORKGROUP_SIZE3), blocksForChannels(outputShape.channels));
        }
        pass.end();
      });
      if (querySet) {
        encoder.resolveQuerySet(querySet, 0, queryCount, queryResolveBuffer, 0);
        encoder.copyBufferToBuffer(queryResolveBuffer, 0, queryReadbackBuffer, 0, queryBufferSize);
      }
      this._device.queue.submit([encoder.finish()]);
    } catch (error) {
      this._releaseBuffer(queryReadbackBuffer);
      this._releaseBuffer(queryResolveBuffer);
      this._releaseQuerySet(querySet);
      throw error;
    }
    if (querySet) {
      this._profileOperations++;
      this._readProfile(querySet, queryResolveBuffer, queryReadbackBuffer, profileLabels);
    }
    return execution.valueBuffers.get(execution.plan.spec.output);
  }
  /**
   * Receives the timestamp queries of a profiled execution. The synchronous
   * core cannot read them back, so it releases them.
   */
  _readProfile(querySet, resolveBuffer, readbackBuffer, labels) {
    void labels;
    this._releaseQuerySet(querySet);
    this._releaseBuffer(resolveBuffer);
    this._releaseBuffer(readbackBuffer);
    this._profileOperations--;
  }
  _releaseBuffer(buffer2) {
    this._resources.release("gpu-buffer", buffer2, () => buffer2.destroy());
  }
  _releaseQuerySet(querySet) {
    this._resources.release("gpu-query-set", querySet, () => querySet.destroy());
  }
  _destroyExecution(execution) {
    execution.slots.forEach((slot) => this._releaseBuffer(slot.buffer));
    execution.ownedBuffers.forEach((buffer2) => this._releaseBuffer(buffer2));
  }
  getResourceInfo() {
    return this._resources.snapshot(this._retiredExecutions.size + this._profileOperations);
  }
  dispose() {
    if (this._disposed)
      return;
    this._disposed = true;
    for (const packed of this._packedConvs.values()) {
      this._releaseBuffer(packed.weights);
      this._releaseBuffer(packed.bias);
    }
    this._packedConvs.clear();
    for (const execution of this._executionCache.values()) {
      this._destroyExecution(execution);
    }
    this._executionCache.clear();
    for (const execution of this._retiredExecutions) {
      this._destroyExecution(execution);
    }
    this._retiredExecutions.clear();
  }
};

// node_modules/oidn-webgpu/lib/nativeUNet.js
function asOIDNDevice(device) {
  return device;
}
var pendingPipelinesByDevice = /* @__PURE__ */ new WeakMap();
var NativeUNetExecutor = class extends NativeUNetCore {
  _lastExecutionProfile;
  constructor(device, model, options) {
    super(asOIDNDevice(device), model, options);
  }
  // Inputs and outputs are buffers of the browser device, so they are GPUBuffers.
  execute(inputBuffers, width, height) {
    return super.execute(inputBuffers, width, height);
  }
  get _asyncDevice() {
    return this._device;
  }
  get _pipelinePromises() {
    let pending = pendingPipelinesByDevice.get(this._device);
    if (!pending) {
      pending = /* @__PURE__ */ new Map();
      pendingPipelinesByDevice.set(this._device, pending);
    }
    return pending;
  }
  getLastExecutionProfile() {
    return this._lastExecutionProfile;
  }
  _pipelineAsync(key, code) {
    const ready = this._pipelineCache.get(key);
    if (ready)
      return Promise.resolve(ready);
    const pending = this._pipelinePromises.get(key);
    if (pending)
      return pending;
    const promise = this._asyncDevice.createComputePipelineAsync({
      label: `oidn/${key}`,
      layout: "auto",
      compute: {
        module: this._device.createShaderModule({
          label: `oidn/${key}`,
          code
        }),
        entryPoint: "main"
      }
    }).then((pipeline) => {
      this._pipelineCache.set(key, pipeline);
      this._pipelinePromises.delete(key);
      return pipeline;
    }, (error) => {
      this._pipelinePromises.delete(key);
      throw error;
    });
    this._pipelinePromises.set(key, promise);
    return promise;
  }
  _retireExecution(execution) {
    this._retiredExecutions.add(execution);
    void this._asyncDevice.queue.onSubmittedWorkDone().catch(() => void 0).then(() => {
      this._retiredExecutions.delete(execution);
      this._destroyExecution(execution);
    });
  }
  /** Compiles all shape-independent kernels before the model reports ready. */
  async prepare() {
    if (this._disposed)
      throw new Error("Native OIDN executor is disposed");
    const graph = optimizeModelGraph(this._model, { fuseConvPool: false });
    const sourceCount = this._model.inputChannels / 3;
    const specs = [
      {
        key: `pack/${this.precision}/${sourceCount}`,
        code: createInputPackShader(this.precision, sourceCount)
      },
      ...graph.nodes.map((node) => this._nodePipelineSpec(node, node.id === graph.spec.output))
    ];
    await Promise.all(specs.map(({ key, code }) => this._pipelineAsync(key, code)));
  }
  _readProfile(querySet, resolveBuffer, readbackBuffer, labels) {
    this._lastExecutionProfile = (async () => {
      try {
        await readbackBuffer.mapAsync(MapMode.READ);
        const words = new Uint32Array(readbackBuffer.getMappedRange());
        const timestamp = (query) => words[query * 2 + 1] * 4294967296 + words[query * 2];
        const layers = labels.map((id, index) => ({
          id,
          durationMs: (timestamp(index * 2 + 1) - timestamp(index * 2)) / 1e6
        }));
        return {
          totalMs: layers.reduce((sum, layer) => sum + layer.durationMs, 0),
          layers
        };
      } finally {
        if (readbackBuffer.mapState === "mapped") {
          readbackBuffer.unmap();
        }
        this._releaseQuerySet(querySet);
        this._releaseBuffer(resolveBuffer);
        this._releaseBuffer(readbackBuffer);
        this._profileOperations--;
      }
    })();
  }
  /** Executes interleaved CPU image data through the native GPU runtime. */
  async executeCPU(interleavedInput, width, height) {
    const expectedLength = width * height * this._model.inputChannels;
    if (interleavedInput.length !== expectedLength) {
      throw new Error(`Native OIDN CPU input has ${interleavedInput.length} values, expected ${expectedLength}`);
    }
    const execution = this._execution(width, height);
    const sourceCount = this._model.inputChannels / 3;
    const pixelCount = width * height;
    if (!execution.cpuInputBuffers) {
      execution.cpuInputBuffers = Array.from({ length: sourceCount }, (_, index) => {
        const buffer2 = this._device.createBuffer({
          label: `oidn/cpu-input/${width}x${height}/${index}`,
          size: pixelCount * 16,
          usage: BufferUsage.STORAGE | BufferUsage.COPY_DST
        });
        this._resources.track("gpu-buffer", buffer2);
        execution.ownedBuffers.push(buffer2);
        return buffer2;
      });
      execution.cpuReadbackBuffer = this._device.createBuffer({
        label: `oidn/cpu-readback/${width}x${height}`,
        size: pixelCount * 16,
        usage: BufferUsage.COPY_DST | BufferUsage.MAP_READ
      });
      this._resources.track("gpu-buffer", execution.cpuReadbackBuffer);
      execution.ownedBuffers.push(execution.cpuReadbackBuffer);
    }
    for (let source = 0; source < sourceCount; source++) {
      const upload = new Float32Array(pixelCount * 4);
      for (let pixel = 0; pixel < pixelCount; pixel++) {
        const inputOffset = pixel * this._model.inputChannels + source * 3;
        const outputOffset = pixel * 4;
        upload[outputOffset] = interleavedInput[inputOffset];
        upload[outputOffset + 1] = interleavedInput[inputOffset + 1];
        upload[outputOffset + 2] = interleavedInput[inputOffset + 2];
      }
      this._device.queue.writeBuffer(execution.cpuInputBuffers[source], 0, new Uint8Array(upload.buffer, upload.byteOffset, upload.byteLength));
    }
    const output = super.execute(execution.cpuInputBuffers, width, height);
    const encoder = this._device.createCommandEncoder({
      label: `oidn/cpu-readback/${width}x${height}`
    });
    encoder.copyBufferToBuffer(output, 0, execution.cpuReadbackBuffer, 0, pixelCount * 16);
    this._device.queue.submit([encoder.finish()]);
    await execution.cpuReadbackBuffer.mapAsync(MapMode.READ);
    const rgba = new Float32Array(execution.cpuReadbackBuffer.getMappedRange());
    const rgb = new Float32Array(pixelCount * 3);
    for (let pixel = 0; pixel < pixelCount; pixel++) {
      rgb[pixel * 3] = rgba[pixel * 4];
      rgb[pixel * 3 + 1] = rgba[pixel * 4 + 1];
      rgb[pixel * 3 + 2] = rgba[pixel * 4 + 2];
    }
    execution.cpuReadbackBuffer.unmap();
    return rgb;
  }
};

// node_modules/@petamoriken/float16/src/_util/messages.mjs
var THIS_IS_NOT_AN_OBJECT = "This is not an object";
var THIS_IS_NOT_A_FLOAT16ARRAY_OBJECT = "This is not a Float16Array object";
var THIS_CONSTRUCTOR_IS_NOT_A_SUBCLASS_OF_FLOAT16ARRAY = "This constructor is not a subclass of Float16Array";
var THE_CONSTRUCTOR_PROPERTY_VALUE_IS_NOT_AN_OBJECT = "The constructor property value is not an object";
var SPECIES_CONSTRUCTOR_DIDNT_RETURN_TYPEDARRAY_OBJECT = "Species constructor didn't return TypedArray object";
var DERIVED_CONSTRUCTOR_CREATED_TYPEDARRAY_OBJECT_WHICH_WAS_TOO_SMALL_LENGTH = "Derived constructor created TypedArray object which was too small length";
var ATTEMPTING_TO_ACCESS_DETACHED_ARRAYBUFFER = "Attempting to access detached ArrayBuffer";
var CANNOT_CONVERT_UNDEFINED_OR_NULL_TO_OBJECT = "Cannot convert undefined or null to object";
var CANNOT_MIX_BIGINT_AND_OTHER_TYPES = "Cannot mix BigInt and other types, use explicit conversions";
var ITERATOR_PROPERTY_IS_NOT_CALLABLE = "@@iterator property is not callable";
var REDUCE_OF_EMPTY_ARRAY_WITH_NO_INITIAL_VALUE = "Reduce of empty array with no initial value";
var THE_COMPARISON_FUNCTION_MUST_BE_EITHER_A_FUNCTION_OR_UNDEFINED = "The comparison function must be either a function or undefined";
var OFFSET_IS_OUT_OF_BOUNDS = "Offset is out of bounds";

// node_modules/@petamoriken/float16/src/_util/primordials.mjs
function uncurryThis(target) {
  return (thisArg, ...args) => {
    return ReflectApply(target, thisArg, args);
  };
}
function uncurryThisGetter(target, key) {
  return uncurryThis(
    ReflectGetOwnPropertyDescriptor(
      target,
      key
    ).get
  );
}
var {
  apply: ReflectApply,
  construct: ReflectConstruct,
  defineProperty: ReflectDefineProperty,
  get: ReflectGet,
  getOwnPropertyDescriptor: ReflectGetOwnPropertyDescriptor,
  getPrototypeOf: ReflectGetPrototypeOf,
  has: ReflectHas,
  ownKeys: ReflectOwnKeys,
  set: ReflectSet,
  setPrototypeOf: ReflectSetPrototypeOf
} = Reflect;
var NativeProxy = Proxy;
var {
  EPSILON,
  MAX_SAFE_INTEGER,
  isFinite: NumberIsFinite,
  isNaN: NumberIsNaN
} = Number;
var {
  iterator: SymbolIterator,
  species: SymbolSpecies,
  toStringTag: SymbolToStringTag,
  for: SymbolFor
} = Symbol;
var NativeObject = Object;
var {
  create: ObjectCreate,
  defineProperty: ObjectDefineProperty,
  freeze: ObjectFreeze,
  is: ObjectIs
} = NativeObject;
var ObjectPrototype = NativeObject.prototype;
var ObjectPrototype__lookupGetter__ = (
  /** @type {any} */
  ObjectPrototype.__lookupGetter__ ? uncurryThis(
    /** @type {any} */
    ObjectPrototype.__lookupGetter__
  ) : (object, key) => {
    if (object == null) {
      throw NativeTypeError(
        CANNOT_CONVERT_UNDEFINED_OR_NULL_TO_OBJECT
      );
    }
    let target = NativeObject(object);
    do {
      const descriptor = ReflectGetOwnPropertyDescriptor(target, key);
      if (descriptor !== void 0) {
        if (ObjectHasOwn(descriptor, "get")) {
          return descriptor.get;
        }
        return;
      }
    } while ((target = ReflectGetPrototypeOf(target)) !== null);
  }
);
var ObjectHasOwn = (
  /** @type {any} */
  NativeObject.hasOwn || uncurryThis(ObjectPrototype.hasOwnProperty)
);
var NativeArray = Array;
var ArrayIsArray = NativeArray.isArray;
var ArrayPrototype = NativeArray.prototype;
var ArrayPrototypeJoin = uncurryThis(ArrayPrototype.join);
var ArrayPrototypePush = uncurryThis(ArrayPrototype.push);
var ArrayPrototypeToLocaleString = uncurryThis(
  ArrayPrototype.toLocaleString
);
var NativeArrayPrototypeSymbolIterator = ArrayPrototype[SymbolIterator];
var ArrayPrototypeSymbolIterator = uncurryThis(NativeArrayPrototypeSymbolIterator);
var {
  abs: MathAbs,
  trunc: MathTrunc
} = Math;
var NativeArrayBuffer = ArrayBuffer;
var ArrayBufferIsView = NativeArrayBuffer.isView;
var ArrayBufferPrototype = NativeArrayBuffer.prototype;
var ArrayBufferPrototypeSlice = uncurryThis(ArrayBufferPrototype.slice);
var ArrayBufferPrototypeGetByteLength = uncurryThisGetter(ArrayBufferPrototype, "byteLength");
var NativeSharedArrayBuffer = typeof SharedArrayBuffer !== "undefined" ? SharedArrayBuffer : null;
var SharedArrayBufferPrototypeGetByteLength = NativeSharedArrayBuffer && uncurryThisGetter(NativeSharedArrayBuffer.prototype, "byteLength");
var TypedArray = ReflectGetPrototypeOf(Uint8Array);
var TypedArrayFrom = TypedArray.from;
var TypedArrayPrototype = TypedArray.prototype;
var NativeTypedArrayPrototypeSymbolIterator = TypedArrayPrototype[SymbolIterator];
var TypedArrayPrototypeKeys = uncurryThis(TypedArrayPrototype.keys);
var TypedArrayPrototypeValues = uncurryThis(
  TypedArrayPrototype.values
);
var TypedArrayPrototypeEntries = uncurryThis(
  TypedArrayPrototype.entries
);
var TypedArrayPrototypeSet = uncurryThis(TypedArrayPrototype.set);
var TypedArrayPrototypeReverse = uncurryThis(
  TypedArrayPrototype.reverse
);
var TypedArrayPrototypeFill = uncurryThis(TypedArrayPrototype.fill);
var TypedArrayPrototypeCopyWithin = uncurryThis(
  TypedArrayPrototype.copyWithin
);
var TypedArrayPrototypeSort = uncurryThis(TypedArrayPrototype.sort);
var TypedArrayPrototypeSlice = uncurryThis(TypedArrayPrototype.slice);
var TypedArrayPrototypeSubarray = uncurryThis(
  TypedArrayPrototype.subarray
);
var TypedArrayPrototypeGetBuffer = uncurryThisGetter(
  TypedArrayPrototype,
  "buffer"
);
var TypedArrayPrototypeGetByteOffset = uncurryThisGetter(
  TypedArrayPrototype,
  "byteOffset"
);
var TypedArrayPrototypeGetLength = uncurryThisGetter(
  TypedArrayPrototype,
  "length"
);
var TypedArrayPrototypeGetSymbolToStringTag = uncurryThisGetter(
  TypedArrayPrototype,
  SymbolToStringTag
);
var NativeUint8Array = Uint8Array;
var NativeUint16Array = Uint16Array;
var Uint16ArrayFrom = (...args) => {
  return ReflectApply(TypedArrayFrom, NativeUint16Array, args);
};
var NativeUint32Array = Uint32Array;
var NativeFloat32Array = Float32Array;
var ArrayIteratorPrototype = ReflectGetPrototypeOf([][SymbolIterator]());
var ArrayIteratorPrototypeNext = uncurryThis(ArrayIteratorPrototype.next);
var GeneratorPrototypeNext = uncurryThis((function* () {
})().next);
var IteratorPrototype = ReflectGetPrototypeOf(ArrayIteratorPrototype);
var DataViewPrototype = DataView.prototype;
var DataViewPrototypeGetUint16 = uncurryThis(
  DataViewPrototype.getUint16
);
var DataViewPrototypeSetUint16 = uncurryThis(
  DataViewPrototype.setUint16
);
var NativeTypeError = TypeError;
var NativeRangeError = RangeError;
var NativeWeakSet = WeakSet;
var WeakSetPrototype = NativeWeakSet.prototype;
var WeakSetPrototypeAdd = uncurryThis(WeakSetPrototype.add);
var WeakSetPrototypeHas = uncurryThis(WeakSetPrototype.has);
var NativeWeakMap = WeakMap;
var WeakMapPrototype = NativeWeakMap.prototype;
var WeakMapPrototypeGet = uncurryThis(WeakMapPrototype.get);
var WeakMapPrototypeHas = uncurryThis(WeakMapPrototype.has);
var WeakMapPrototypeSet = uncurryThis(WeakMapPrototype.set);

// node_modules/@petamoriken/float16/src/_util/arrayIterator.mjs
var arrayIterators = new NativeWeakMap();
var SafeIteratorPrototype = ObjectCreate(null, {
  next: {
    value: function next() {
      const arrayIterator = WeakMapPrototypeGet(arrayIterators, this);
      return ArrayIteratorPrototypeNext(arrayIterator);
    }
  },
  [SymbolIterator]: {
    value: function values() {
      return this;
    }
  }
});
function safeIfNeeded(array) {
  if (array[SymbolIterator] === NativeArrayPrototypeSymbolIterator && ArrayIteratorPrototype.next === ArrayIteratorPrototypeNext) {
    return array;
  }
  const safe = ObjectCreate(SafeIteratorPrototype);
  WeakMapPrototypeSet(arrayIterators, safe, ArrayPrototypeSymbolIterator(array));
  return safe;
}
var generators = new NativeWeakMap();
var DummyArrayIteratorPrototype = ObjectCreate(IteratorPrototype, {
  next: {
    value: function next2() {
      const generator = WeakMapPrototypeGet(generators, this);
      return GeneratorPrototypeNext(generator);
    },
    writable: true,
    configurable: true
  }
});
for (const key of ReflectOwnKeys(ArrayIteratorPrototype)) {
  if (key === "next") {
    continue;
  }
  ObjectDefineProperty(DummyArrayIteratorPrototype, key, ReflectGetOwnPropertyDescriptor(ArrayIteratorPrototype, key));
}
function wrap(generator) {
  const dummy = ObjectCreate(DummyArrayIteratorPrototype);
  WeakMapPrototypeSet(generators, dummy, generator);
  return dummy;
}

// node_modules/@petamoriken/float16/src/_util/is.mjs
function isObject(value) {
  return value !== null && typeof value === "object" || typeof value === "function";
}
function isObjectLike(value) {
  return value !== null && typeof value === "object";
}
function isNativeTypedArray(value) {
  return TypedArrayPrototypeGetSymbolToStringTag(value) !== void 0;
}
function isNativeBigIntTypedArray(value) {
  const typedArrayName = TypedArrayPrototypeGetSymbolToStringTag(value);
  return typedArrayName === "BigInt64Array" || typedArrayName === "BigUint64Array";
}
function isArrayBuffer(value) {
  try {
    if (ArrayIsArray(value)) {
      return false;
    }
    ArrayBufferPrototypeGetByteLength(
      /** @type {any} */
      value
    );
    return true;
  } catch (e2) {
    return false;
  }
}
function isSharedArrayBuffer(value) {
  if (NativeSharedArrayBuffer === null) {
    return false;
  }
  try {
    SharedArrayBufferPrototypeGetByteLength(
      /** @type {any} */
      value
    );
    return true;
  } catch (e2) {
    return false;
  }
}
function isAnyArrayBuffer(value) {
  return isArrayBuffer(value) || isSharedArrayBuffer(value);
}
function isOrdinaryArray(value) {
  if (!ArrayIsArray(value)) {
    return false;
  }
  return value[SymbolIterator] === NativeArrayPrototypeSymbolIterator && ArrayIteratorPrototype.next === ArrayIteratorPrototypeNext;
}
function isOrdinaryNativeTypedArray(value) {
  if (!isNativeTypedArray(value)) {
    return false;
  }
  return value[SymbolIterator] === NativeTypedArrayPrototypeSymbolIterator && ArrayIteratorPrototype.next === ArrayIteratorPrototypeNext;
}
function isCanonicalIntegerIndexString(value) {
  if (typeof value !== "string") {
    return false;
  }
  const number = +value;
  if (value !== number + "") {
    return false;
  }
  if (!NumberIsFinite(number)) {
    return false;
  }
  return number === MathTrunc(number);
}

// node_modules/@petamoriken/float16/src/_util/brand.mjs
var brand = SymbolFor("__Float16Array__");
function hasFloat16ArrayBrand(target) {
  if (!isObjectLike(target)) {
    return false;
  }
  const prototype = ReflectGetPrototypeOf(target);
  if (!isObjectLike(prototype)) {
    return false;
  }
  const constructor = prototype.constructor;
  if (constructor === void 0) {
    return false;
  }
  if (!isObject(constructor)) {
    throw NativeTypeError(THE_CONSTRUCTOR_PROPERTY_VALUE_IS_NOT_AN_OBJECT);
  }
  return ReflectHas(constructor, brand);
}

// node_modules/@petamoriken/float16/src/_util/converter.mjs
var INVERSE_OF_EPSILON = 1 / EPSILON;
function roundTiesToEven(num) {
  return num + INVERSE_OF_EPSILON - INVERSE_OF_EPSILON;
}
var FLOAT16_MIN_VALUE = 6103515625e-14;
var FLOAT16_MAX_VALUE = 65504;
var FLOAT16_EPSILON = 9765625e-10;
var FLOAT16_EPSILON_MULTIPLIED_BY_FLOAT16_MIN_VALUE = FLOAT16_EPSILON * FLOAT16_MIN_VALUE;
var FLOAT16_EPSILON_DEVIDED_BY_EPSILON = FLOAT16_EPSILON * INVERSE_OF_EPSILON;
function roundToFloat16(num) {
  const number = +num;
  if (!NumberIsFinite(number) || number === 0) {
    return number;
  }
  const sign = number > 0 ? 1 : -1;
  const absolute = MathAbs(number);
  if (absolute < FLOAT16_MIN_VALUE) {
    return sign * roundTiesToEven(absolute / FLOAT16_EPSILON_MULTIPLIED_BY_FLOAT16_MIN_VALUE) * FLOAT16_EPSILON_MULTIPLIED_BY_FLOAT16_MIN_VALUE;
  }
  const temp = (1 + FLOAT16_EPSILON_DEVIDED_BY_EPSILON) * absolute;
  const result = temp - (temp - absolute);
  if (result > FLOAT16_MAX_VALUE || NumberIsNaN(result)) {
    return sign * Infinity;
  }
  return sign * result;
}
var buffer = new NativeArrayBuffer(4);
var floatView = new NativeFloat32Array(buffer);
var uint32View = new NativeUint32Array(buffer);
var baseTable = new NativeUint16Array(512);
var shiftTable = new NativeUint8Array(512);
for (let i = 0; i < 256; ++i) {
  const e2 = i - 127;
  if (e2 < -24) {
    baseTable[i] = 0;
    baseTable[i | 256] = 32768;
    shiftTable[i] = 24;
    shiftTable[i | 256] = 24;
  } else if (e2 < -14) {
    baseTable[i] = 1024 >> -e2 - 14;
    baseTable[i | 256] = 1024 >> -e2 - 14 | 32768;
    shiftTable[i] = -e2 - 1;
    shiftTable[i | 256] = -e2 - 1;
  } else if (e2 <= 15) {
    baseTable[i] = e2 + 15 << 10;
    baseTable[i | 256] = e2 + 15 << 10 | 32768;
    shiftTable[i] = 13;
    shiftTable[i | 256] = 13;
  } else if (e2 < 128) {
    baseTable[i] = 31744;
    baseTable[i | 256] = 64512;
    shiftTable[i] = 24;
    shiftTable[i | 256] = 24;
  } else {
    baseTable[i] = 31744;
    baseTable[i | 256] = 64512;
    shiftTable[i] = 13;
    shiftTable[i | 256] = 13;
  }
}
function roundToFloat16Bits(num) {
  floatView[0] = roundToFloat16(num);
  const f2 = uint32View[0];
  const e2 = f2 >> 23 & 511;
  return baseTable[e2] + ((f2 & 8388607) >> shiftTable[e2]);
}
var mantissaTable = new NativeUint32Array(2048);
for (let i = 1; i < 1024; ++i) {
  let m = i << 13;
  let e2 = 0;
  while ((m & 8388608) === 0) {
    m <<= 1;
    e2 -= 8388608;
  }
  m &= ~8388608;
  e2 += 947912704;
  mantissaTable[i] = m | e2;
}
for (let i = 1024; i < 2048; ++i) {
  mantissaTable[i] = 939524096 + (i - 1024 << 13);
}
var exponentTable = new NativeUint32Array(64);
for (let i = 1; i < 31; ++i) {
  exponentTable[i] = i << 23;
}
exponentTable[31] = 1199570944;
exponentTable[32] = 2147483648;
for (let i = 33; i < 63; ++i) {
  exponentTable[i] = 2147483648 + (i - 32 << 23);
}
exponentTable[63] = 3347054592;
var offsetTable = new NativeUint16Array(64);
for (let i = 1; i < 64; ++i) {
  if (i !== 32) {
    offsetTable[i] = 1024;
  }
}
function convertToNumber(float16bits) {
  const i = float16bits >> 10;
  uint32View[0] = mantissaTable[offsetTable[i] + (float16bits & 1023)] + exponentTable[i];
  return floatView[0];
}

// node_modules/@petamoriken/float16/src/_util/spec.mjs
function ToIntegerOrInfinity(target) {
  const number = +target;
  if (NumberIsNaN(number) || number === 0) {
    return 0;
  }
  return MathTrunc(number);
}
function ToLength(target) {
  const length = ToIntegerOrInfinity(target);
  if (length < 0) {
    return 0;
  }
  return length < MAX_SAFE_INTEGER ? length : MAX_SAFE_INTEGER;
}
function SpeciesConstructor(target, defaultConstructor) {
  if (!isObject(target)) {
    throw NativeTypeError(THIS_IS_NOT_AN_OBJECT);
  }
  const constructor = target.constructor;
  if (constructor === void 0) {
    return defaultConstructor;
  }
  if (!isObject(constructor)) {
    throw NativeTypeError(THE_CONSTRUCTOR_PROPERTY_VALUE_IS_NOT_AN_OBJECT);
  }
  const species = constructor[SymbolSpecies];
  if (species == null) {
    return defaultConstructor;
  }
  return species;
}
function IsDetachedBuffer(buffer2) {
  if (isSharedArrayBuffer(buffer2)) {
    return false;
  }
  try {
    ArrayBufferPrototypeSlice(buffer2, 0, 0);
    return false;
  } catch (e2) {
  }
  return true;
}
function defaultCompare(x, y) {
  const isXNaN = NumberIsNaN(x);
  const isYNaN = NumberIsNaN(y);
  if (isXNaN && isYNaN) {
    return 0;
  }
  if (isXNaN) {
    return 1;
  }
  if (isYNaN) {
    return -1;
  }
  if (x < y) {
    return -1;
  }
  if (x > y) {
    return 1;
  }
  if (x === 0 && y === 0) {
    const isXPlusZero = ObjectIs(x, 0);
    const isYPlusZero = ObjectIs(y, 0);
    if (!isXPlusZero && isYPlusZero) {
      return -1;
    }
    if (isXPlusZero && !isYPlusZero) {
      return 1;
    }
  }
  return 0;
}

// node_modules/@petamoriken/float16/src/Float16Array.mjs
var BYTES_PER_ELEMENT = 2;
var float16bitsArrays = new NativeWeakMap();
function isFloat16Array(target) {
  return WeakMapPrototypeHas(float16bitsArrays, target) || !ArrayBufferIsView(target) && hasFloat16ArrayBrand(target);
}
function assertFloat16Array(target) {
  if (!isFloat16Array(target)) {
    throw NativeTypeError(THIS_IS_NOT_A_FLOAT16ARRAY_OBJECT);
  }
}
function assertSpeciesTypedArray(target, count) {
  const isTargetFloat16Array = isFloat16Array(target);
  const isTargetTypedArray = isNativeTypedArray(target);
  if (!isTargetFloat16Array && !isTargetTypedArray) {
    throw NativeTypeError(SPECIES_CONSTRUCTOR_DIDNT_RETURN_TYPEDARRAY_OBJECT);
  }
  if (typeof count === "number") {
    let length;
    if (isTargetFloat16Array) {
      const float16bitsArray = getFloat16BitsArray(target);
      length = TypedArrayPrototypeGetLength(float16bitsArray);
    } else {
      length = TypedArrayPrototypeGetLength(target);
    }
    if (length < count) {
      throw NativeTypeError(
        DERIVED_CONSTRUCTOR_CREATED_TYPEDARRAY_OBJECT_WHICH_WAS_TOO_SMALL_LENGTH
      );
    }
  }
  if (isNativeBigIntTypedArray(target)) {
    throw NativeTypeError(CANNOT_MIX_BIGINT_AND_OTHER_TYPES);
  }
}
function getFloat16BitsArray(float16) {
  const float16bitsArray = WeakMapPrototypeGet(float16bitsArrays, float16);
  if (float16bitsArray !== void 0) {
    const buffer3 = TypedArrayPrototypeGetBuffer(float16bitsArray);
    if (IsDetachedBuffer(buffer3)) {
      throw NativeTypeError(ATTEMPTING_TO_ACCESS_DETACHED_ARRAYBUFFER);
    }
    return float16bitsArray;
  }
  const buffer2 = (
    /** @type {any} */
    float16.buffer
  );
  if (IsDetachedBuffer(buffer2)) {
    throw NativeTypeError(ATTEMPTING_TO_ACCESS_DETACHED_ARRAYBUFFER);
  }
  const cloned = ReflectConstruct(Float16Array, [
    buffer2,
    /** @type {any} */
    float16.byteOffset,
    /** @type {any} */
    float16.length
  ], float16.constructor);
  return WeakMapPrototypeGet(float16bitsArrays, cloned);
}
function copyToArray(float16bitsArray) {
  const length = TypedArrayPrototypeGetLength(float16bitsArray);
  const array = [];
  for (let i = 0; i < length; ++i) {
    array[i] = convertToNumber(float16bitsArray[i]);
  }
  return array;
}
var TypedArrayPrototypeGetters = new NativeWeakSet();
for (const key of ReflectOwnKeys(TypedArrayPrototype)) {
  if (key === SymbolToStringTag) {
    continue;
  }
  const descriptor = ReflectGetOwnPropertyDescriptor(TypedArrayPrototype, key);
  if (ObjectHasOwn(descriptor, "get") && typeof descriptor.get === "function") {
    WeakSetPrototypeAdd(TypedArrayPrototypeGetters, descriptor.get);
  }
}
var handler = ObjectFreeze(
  /** @type {ProxyHandler<Float16BitsArray>} */
  {
    get(target, key, receiver) {
      if (isCanonicalIntegerIndexString(key) && ObjectHasOwn(target, key)) {
        return convertToNumber(ReflectGet(target, key));
      }
      if (WeakSetPrototypeHas(TypedArrayPrototypeGetters, ObjectPrototype__lookupGetter__(target, key))) {
        return ReflectGet(target, key);
      }
      return ReflectGet(target, key, receiver);
    },
    set(target, key, value, receiver) {
      if (isCanonicalIntegerIndexString(key) && ObjectHasOwn(target, key)) {
        return ReflectSet(target, key, roundToFloat16Bits(value));
      }
      return ReflectSet(target, key, value, receiver);
    },
    getOwnPropertyDescriptor(target, key) {
      if (isCanonicalIntegerIndexString(key) && ObjectHasOwn(target, key)) {
        const descriptor = ReflectGetOwnPropertyDescriptor(target, key);
        descriptor.value = convertToNumber(descriptor.value);
        return descriptor;
      }
      return ReflectGetOwnPropertyDescriptor(target, key);
    },
    defineProperty(target, key, descriptor) {
      if (isCanonicalIntegerIndexString(key) && ObjectHasOwn(target, key) && ObjectHasOwn(descriptor, "value")) {
        descriptor.value = roundToFloat16Bits(descriptor.value);
        return ReflectDefineProperty(target, key, descriptor);
      }
      return ReflectDefineProperty(target, key, descriptor);
    }
  }
);
var Float16Array = class _Float16Array {
  /** @see https://tc39.es/ecma262/#sec-typedarray */
  constructor(input, _byteOffset, _length) {
    let float16bitsArray;
    if (isFloat16Array(input)) {
      float16bitsArray = ReflectConstruct(NativeUint16Array, [getFloat16BitsArray(input)], new.target);
    } else if (isObject(input) && !isAnyArrayBuffer(input)) {
      let list;
      let length;
      if (isNativeTypedArray(input)) {
        list = input;
        length = TypedArrayPrototypeGetLength(input);
        const buffer2 = TypedArrayPrototypeGetBuffer(input);
        if (IsDetachedBuffer(buffer2)) {
          throw NativeTypeError(ATTEMPTING_TO_ACCESS_DETACHED_ARRAYBUFFER);
        }
        if (isNativeBigIntTypedArray(input)) {
          throw NativeTypeError(CANNOT_MIX_BIGINT_AND_OTHER_TYPES);
        }
        const data = new NativeArrayBuffer(
          length * BYTES_PER_ELEMENT
        );
        float16bitsArray = ReflectConstruct(NativeUint16Array, [data], new.target);
      } else {
        const iterator = input[SymbolIterator];
        if (iterator != null && typeof iterator !== "function") {
          throw NativeTypeError(ITERATOR_PROPERTY_IS_NOT_CALLABLE);
        }
        if (iterator != null) {
          if (isOrdinaryArray(input)) {
            list = input;
            length = input.length;
          } else {
            list = [.../** @type {Iterable<unknown>} */
            input];
            length = list.length;
          }
        } else {
          list = /** @type {ArrayLike<unknown>} */
          input;
          length = ToLength(list.length);
        }
        float16bitsArray = ReflectConstruct(NativeUint16Array, [length], new.target);
      }
      for (let i = 0; i < length; ++i) {
        float16bitsArray[i] = roundToFloat16Bits(list[i]);
      }
    } else {
      float16bitsArray = ReflectConstruct(NativeUint16Array, arguments, new.target);
    }
    const proxy = (
      /** @type {any} */
      new NativeProxy(float16bitsArray, handler)
    );
    WeakMapPrototypeSet(float16bitsArrays, proxy, float16bitsArray);
    return proxy;
  }
  /**
   * limitation: `Object.getOwnPropertyNames(Float16Array)` or `Reflect.ownKeys(Float16Array)` include this key
   * @see https://tc39.es/ecma262/#sec-%typedarray%.from
   */
  static from(src, ...opts) {
    const Constructor = this;
    if (!ReflectHas(Constructor, brand)) {
      throw NativeTypeError(
        THIS_CONSTRUCTOR_IS_NOT_A_SUBCLASS_OF_FLOAT16ARRAY
      );
    }
    if (Constructor === _Float16Array) {
      if (isFloat16Array(src) && opts.length === 0) {
        const float16bitsArray = getFloat16BitsArray(src);
        const uint16 = new NativeUint16Array(
          TypedArrayPrototypeGetBuffer(float16bitsArray),
          TypedArrayPrototypeGetByteOffset(float16bitsArray),
          TypedArrayPrototypeGetLength(float16bitsArray)
        );
        return new _Float16Array(
          TypedArrayPrototypeGetBuffer(TypedArrayPrototypeSlice(uint16))
        );
      }
      if (opts.length === 0) {
        return new _Float16Array(
          TypedArrayPrototypeGetBuffer(
            Uint16ArrayFrom(src, roundToFloat16Bits)
          )
        );
      }
      const mapFunc = opts[0];
      const thisArg = opts[1];
      return new _Float16Array(
        TypedArrayPrototypeGetBuffer(
          Uint16ArrayFrom(src, function(val, ...args) {
            return roundToFloat16Bits(
              ReflectApply(mapFunc, this, [val, ...safeIfNeeded(args)])
            );
          }, thisArg)
        )
      );
    }
    let list;
    let length;
    const iterator = src[SymbolIterator];
    if (iterator != null && typeof iterator !== "function") {
      throw NativeTypeError(ITERATOR_PROPERTY_IS_NOT_CALLABLE);
    }
    if (iterator != null) {
      if (isOrdinaryArray(src)) {
        list = src;
        length = src.length;
      } else if (isOrdinaryNativeTypedArray(src)) {
        list = src;
        length = TypedArrayPrototypeGetLength(src);
      } else {
        list = [...src];
        length = list.length;
      }
    } else {
      if (src == null) {
        throw NativeTypeError(
          CANNOT_CONVERT_UNDEFINED_OR_NULL_TO_OBJECT
        );
      }
      list = NativeObject(src);
      length = ToLength(list.length);
    }
    const array = new Constructor(length);
    if (opts.length === 0) {
      for (let i = 0; i < length; ++i) {
        array[i] = /** @type {number} */
        list[i];
      }
    } else {
      const mapFunc = opts[0];
      const thisArg = opts[1];
      for (let i = 0; i < length; ++i) {
        array[i] = ReflectApply(mapFunc, thisArg, [list[i], i]);
      }
    }
    return array;
  }
  /**
   * limitation: `Object.getOwnPropertyNames(Float16Array)` or `Reflect.ownKeys(Float16Array)` include this key
   * @see https://tc39.es/ecma262/#sec-%typedarray%.of
   */
  static of(...items) {
    const Constructor = this;
    if (!ReflectHas(Constructor, brand)) {
      throw NativeTypeError(
        THIS_CONSTRUCTOR_IS_NOT_A_SUBCLASS_OF_FLOAT16ARRAY
      );
    }
    const length = items.length;
    if (Constructor === _Float16Array) {
      const proxy = new _Float16Array(length);
      const float16bitsArray = getFloat16BitsArray(proxy);
      for (let i = 0; i < length; ++i) {
        float16bitsArray[i] = roundToFloat16Bits(items[i]);
      }
      return proxy;
    }
    const array = new Constructor(length);
    for (let i = 0; i < length; ++i) {
      array[i] = items[i];
    }
    return array;
  }
  /** @see https://tc39.es/ecma262/#sec-%typedarray%.prototype.keys */
  keys() {
    assertFloat16Array(this);
    const float16bitsArray = getFloat16BitsArray(this);
    return TypedArrayPrototypeKeys(float16bitsArray);
  }
  /**
   * limitation: returns a object whose prototype is not `%ArrayIteratorPrototype%`
   * @see https://tc39.es/ecma262/#sec-%typedarray%.prototype.values
   */
  values() {
    assertFloat16Array(this);
    const float16bitsArray = getFloat16BitsArray(this);
    return wrap((function* () {
      for (const val of TypedArrayPrototypeValues(float16bitsArray)) {
        yield convertToNumber(val);
      }
    })());
  }
  /**
   * limitation: returns a object whose prototype is not `%ArrayIteratorPrototype%`
   * @see https://tc39.es/ecma262/#sec-%typedarray%.prototype.entries
   */
  entries() {
    assertFloat16Array(this);
    const float16bitsArray = getFloat16BitsArray(this);
    return wrap((function* () {
      for (const [i, val] of TypedArrayPrototypeEntries(float16bitsArray)) {
        yield (
          /** @type {[number, number]} */
          [i, convertToNumber(val)]
        );
      }
    })());
  }
  /** @see https://tc39.es/ecma262/#sec-%typedarray%.prototype.at */
  at(index) {
    assertFloat16Array(this);
    const float16bitsArray = getFloat16BitsArray(this);
    const length = TypedArrayPrototypeGetLength(float16bitsArray);
    const relativeIndex = ToIntegerOrInfinity(index);
    const k = relativeIndex >= 0 ? relativeIndex : length + relativeIndex;
    if (k < 0 || k >= length) {
      return;
    }
    return convertToNumber(float16bitsArray[k]);
  }
  /** @see https://tc39.es/proposal-change-array-by-copy/#sec-%typedarray%.prototype.with */
  with(index, value) {
    assertFloat16Array(this);
    const float16bitsArray = getFloat16BitsArray(this);
    const length = TypedArrayPrototypeGetLength(float16bitsArray);
    const relativeIndex = ToIntegerOrInfinity(index);
    const k = relativeIndex >= 0 ? relativeIndex : length + relativeIndex;
    const number = +value;
    if (k < 0 || k >= length) {
      throw NativeRangeError(OFFSET_IS_OUT_OF_BOUNDS);
    }
    const uint16 = new NativeUint16Array(
      TypedArrayPrototypeGetBuffer(float16bitsArray),
      TypedArrayPrototypeGetByteOffset(float16bitsArray),
      TypedArrayPrototypeGetLength(float16bitsArray)
    );
    const cloned = new _Float16Array(
      TypedArrayPrototypeGetBuffer(
        TypedArrayPrototypeSlice(uint16)
      )
    );
    const array = getFloat16BitsArray(cloned);
    array[k] = roundToFloat16Bits(number);
    return cloned;
  }
  /** @see https://tc39.es/ecma262/#sec-%typedarray%.prototype.map */
  map(callback, ...opts) {
    assertFloat16Array(this);
    const float16bitsArray = getFloat16BitsArray(this);
    const length = TypedArrayPrototypeGetLength(float16bitsArray);
    const thisArg = opts[0];
    const Constructor = SpeciesConstructor(float16bitsArray, _Float16Array);
    if (Constructor === _Float16Array) {
      const proxy = new _Float16Array(length);
      const array2 = getFloat16BitsArray(proxy);
      for (let i = 0; i < length; ++i) {
        const val = convertToNumber(float16bitsArray[i]);
        array2[i] = roundToFloat16Bits(
          ReflectApply(callback, thisArg, [val, i, this])
        );
      }
      return proxy;
    }
    const array = new Constructor(length);
    assertSpeciesTypedArray(array, length);
    for (let i = 0; i < length; ++i) {
      const val = convertToNumber(float16bitsArray[i]);
      array[i] = ReflectApply(callback, thisArg, [val, i, this]);
    }
    return (
      /** @type {any} */
      array
    );
  }
  /** @see https://tc39.es/ecma262/#sec-%typedarray%.prototype.filter */
  filter(callback, ...opts) {
    assertFloat16Array(this);
    const float16bitsArray = getFloat16BitsArray(this);
    const length = TypedArrayPrototypeGetLength(float16bitsArray);
    const thisArg = opts[0];
    const kept = [];
    for (let i = 0; i < length; ++i) {
      const val = convertToNumber(float16bitsArray[i]);
      if (ReflectApply(callback, thisArg, [val, i, this])) {
        ArrayPrototypePush(kept, val);
      }
    }
    const Constructor = SpeciesConstructor(float16bitsArray, _Float16Array);
    const array = new Constructor(kept);
    assertSpeciesTypedArray(array);
    return (
      /** @type {any} */
      array
    );
  }
  /** @see https://tc39.es/ecma262/#sec-%typedarray%.prototype.reduce */
  reduce(callback, ...opts) {
    assertFloat16Array(this);
    const float16bitsArray = getFloat16BitsArray(this);
    const length = TypedArrayPrototypeGetLength(float16bitsArray);
    if (length === 0 && opts.length === 0) {
      throw NativeTypeError(REDUCE_OF_EMPTY_ARRAY_WITH_NO_INITIAL_VALUE);
    }
    let accumulator, start;
    if (opts.length === 0) {
      accumulator = convertToNumber(float16bitsArray[0]);
      start = 1;
    } else {
      accumulator = opts[0];
      start = 0;
    }
    for (let i = start; i < length; ++i) {
      accumulator = callback(
        accumulator,
        convertToNumber(float16bitsArray[i]),
        i,
        this
      );
    }
    return accumulator;
  }
  /** @see https://tc39.es/ecma262/#sec-%typedarray%.prototype.reduceright */
  reduceRight(callback, ...opts) {
    assertFloat16Array(this);
    const float16bitsArray = getFloat16BitsArray(this);
    const length = TypedArrayPrototypeGetLength(float16bitsArray);
    if (length === 0 && opts.length === 0) {
      throw NativeTypeError(REDUCE_OF_EMPTY_ARRAY_WITH_NO_INITIAL_VALUE);
    }
    let accumulator, start;
    if (opts.length === 0) {
      accumulator = convertToNumber(float16bitsArray[length - 1]);
      start = length - 2;
    } else {
      accumulator = opts[0];
      start = length - 1;
    }
    for (let i = start; i >= 0; --i) {
      accumulator = callback(
        accumulator,
        convertToNumber(float16bitsArray[i]),
        i,
        this
      );
    }
    return accumulator;
  }
  /** @see https://tc39.es/ecma262/#sec-%typedarray%.prototype.foreach */
  forEach(callback, ...opts) {
    assertFloat16Array(this);
    const float16bitsArray = getFloat16BitsArray(this);
    const length = TypedArrayPrototypeGetLength(float16bitsArray);
    const thisArg = opts[0];
    for (let i = 0; i < length; ++i) {
      ReflectApply(callback, thisArg, [
        convertToNumber(float16bitsArray[i]),
        i,
        this
      ]);
    }
  }
  /** @see https://tc39.es/ecma262/#sec-%typedarray%.prototype.find */
  find(callback, ...opts) {
    assertFloat16Array(this);
    const float16bitsArray = getFloat16BitsArray(this);
    const length = TypedArrayPrototypeGetLength(float16bitsArray);
    const thisArg = opts[0];
    for (let i = 0; i < length; ++i) {
      const value = convertToNumber(float16bitsArray[i]);
      if (ReflectApply(callback, thisArg, [value, i, this])) {
        return value;
      }
    }
  }
  /** @see https://tc39.es/ecma262/#sec-%typedarray%.prototype.findindex */
  findIndex(callback, ...opts) {
    assertFloat16Array(this);
    const float16bitsArray = getFloat16BitsArray(this);
    const length = TypedArrayPrototypeGetLength(float16bitsArray);
    const thisArg = opts[0];
    for (let i = 0; i < length; ++i) {
      const value = convertToNumber(float16bitsArray[i]);
      if (ReflectApply(callback, thisArg, [value, i, this])) {
        return i;
      }
    }
    return -1;
  }
  /** @see https://tc39.es/proposal-array-find-from-last/index.html#sec-%typedarray%.prototype.findlast */
  findLast(callback, ...opts) {
    assertFloat16Array(this);
    const float16bitsArray = getFloat16BitsArray(this);
    const length = TypedArrayPrototypeGetLength(float16bitsArray);
    const thisArg = opts[0];
    for (let i = length - 1; i >= 0; --i) {
      const value = convertToNumber(float16bitsArray[i]);
      if (ReflectApply(callback, thisArg, [value, i, this])) {
        return value;
      }
    }
  }
  /** @see https://tc39.es/proposal-array-find-from-last/index.html#sec-%typedarray%.prototype.findlastindex */
  findLastIndex(callback, ...opts) {
    assertFloat16Array(this);
    const float16bitsArray = getFloat16BitsArray(this);
    const length = TypedArrayPrototypeGetLength(float16bitsArray);
    const thisArg = opts[0];
    for (let i = length - 1; i >= 0; --i) {
      const value = convertToNumber(float16bitsArray[i]);
      if (ReflectApply(callback, thisArg, [value, i, this])) {
        return i;
      }
    }
    return -1;
  }
  /** @see https://tc39.es/ecma262/#sec-%typedarray%.prototype.every */
  every(callback, ...opts) {
    assertFloat16Array(this);
    const float16bitsArray = getFloat16BitsArray(this);
    const length = TypedArrayPrototypeGetLength(float16bitsArray);
    const thisArg = opts[0];
    for (let i = 0; i < length; ++i) {
      if (!ReflectApply(callback, thisArg, [
        convertToNumber(float16bitsArray[i]),
        i,
        this
      ])) {
        return false;
      }
    }
    return true;
  }
  /** @see https://tc39.es/ecma262/#sec-%typedarray%.prototype.some */
  some(callback, ...opts) {
    assertFloat16Array(this);
    const float16bitsArray = getFloat16BitsArray(this);
    const length = TypedArrayPrototypeGetLength(float16bitsArray);
    const thisArg = opts[0];
    for (let i = 0; i < length; ++i) {
      if (ReflectApply(callback, thisArg, [
        convertToNumber(float16bitsArray[i]),
        i,
        this
      ])) {
        return true;
      }
    }
    return false;
  }
  /** @see https://tc39.es/ecma262/#sec-%typedarray%.prototype.set */
  set(input, ...opts) {
    assertFloat16Array(this);
    const float16bitsArray = getFloat16BitsArray(this);
    const targetOffset = ToIntegerOrInfinity(opts[0]);
    if (targetOffset < 0) {
      throw NativeRangeError(OFFSET_IS_OUT_OF_BOUNDS);
    }
    if (input == null) {
      throw NativeTypeError(
        CANNOT_CONVERT_UNDEFINED_OR_NULL_TO_OBJECT
      );
    }
    if (isNativeBigIntTypedArray(input)) {
      throw NativeTypeError(
        CANNOT_MIX_BIGINT_AND_OTHER_TYPES
      );
    }
    if (isFloat16Array(input)) {
      return TypedArrayPrototypeSet(
        getFloat16BitsArray(this),
        getFloat16BitsArray(input),
        targetOffset
      );
    }
    if (isNativeTypedArray(input)) {
      const buffer2 = TypedArrayPrototypeGetBuffer(input);
      if (IsDetachedBuffer(buffer2)) {
        throw NativeTypeError(ATTEMPTING_TO_ACCESS_DETACHED_ARRAYBUFFER);
      }
    }
    const targetLength = TypedArrayPrototypeGetLength(float16bitsArray);
    const src = NativeObject(input);
    const srcLength = ToLength(src.length);
    if (targetOffset === Infinity || srcLength + targetOffset > targetLength) {
      throw NativeRangeError(OFFSET_IS_OUT_OF_BOUNDS);
    }
    for (let i = 0; i < srcLength; ++i) {
      float16bitsArray[i + targetOffset] = roundToFloat16Bits(src[i]);
    }
  }
  /** @see https://tc39.es/ecma262/#sec-%typedarray%.prototype.reverse */
  reverse() {
    assertFloat16Array(this);
    const float16bitsArray = getFloat16BitsArray(this);
    TypedArrayPrototypeReverse(float16bitsArray);
    return this;
  }
  /** @see https://tc39.es/proposal-change-array-by-copy/#sec-%typedarray%.prototype.toReversed */
  toReversed() {
    assertFloat16Array(this);
    const float16bitsArray = getFloat16BitsArray(this);
    const uint16 = new NativeUint16Array(
      TypedArrayPrototypeGetBuffer(float16bitsArray),
      TypedArrayPrototypeGetByteOffset(float16bitsArray),
      TypedArrayPrototypeGetLength(float16bitsArray)
    );
    const cloned = new _Float16Array(
      TypedArrayPrototypeGetBuffer(
        TypedArrayPrototypeSlice(uint16)
      )
    );
    const clonedFloat16bitsArray = getFloat16BitsArray(cloned);
    TypedArrayPrototypeReverse(clonedFloat16bitsArray);
    return cloned;
  }
  /** @see https://tc39.es/ecma262/#sec-%typedarray%.prototype.fill */
  fill(value, ...opts) {
    assertFloat16Array(this);
    const float16bitsArray = getFloat16BitsArray(this);
    TypedArrayPrototypeFill(
      float16bitsArray,
      roundToFloat16Bits(value),
      ...safeIfNeeded(opts)
    );
    return this;
  }
  /** @see https://tc39.es/ecma262/#sec-%typedarray%.prototype.copywithin */
  copyWithin(target, start, ...opts) {
    assertFloat16Array(this);
    const float16bitsArray = getFloat16BitsArray(this);
    TypedArrayPrototypeCopyWithin(float16bitsArray, target, start, ...safeIfNeeded(opts));
    return this;
  }
  /** @see https://tc39.es/ecma262/#sec-%typedarray%.prototype.sort */
  sort(compareFn) {
    assertFloat16Array(this);
    const float16bitsArray = getFloat16BitsArray(this);
    const sortCompare = compareFn !== void 0 ? compareFn : defaultCompare;
    TypedArrayPrototypeSort(float16bitsArray, (x, y) => {
      return sortCompare(convertToNumber(x), convertToNumber(y));
    });
    return this;
  }
  /** @see https://tc39.es/proposal-change-array-by-copy/#sec-%typedarray%.prototype.toSorted */
  toSorted(compareFn) {
    assertFloat16Array(this);
    const float16bitsArray = getFloat16BitsArray(this);
    if (compareFn !== void 0 && typeof compareFn !== "function") {
      throw new NativeTypeError(THE_COMPARISON_FUNCTION_MUST_BE_EITHER_A_FUNCTION_OR_UNDEFINED);
    }
    const sortCompare = compareFn !== void 0 ? compareFn : defaultCompare;
    const uint16 = new NativeUint16Array(
      TypedArrayPrototypeGetBuffer(float16bitsArray),
      TypedArrayPrototypeGetByteOffset(float16bitsArray),
      TypedArrayPrototypeGetLength(float16bitsArray)
    );
    const cloned = new _Float16Array(
      TypedArrayPrototypeGetBuffer(
        TypedArrayPrototypeSlice(uint16)
      )
    );
    const clonedFloat16bitsArray = getFloat16BitsArray(cloned);
    TypedArrayPrototypeSort(clonedFloat16bitsArray, (x, y) => {
      return sortCompare(convertToNumber(x), convertToNumber(y));
    });
    return cloned;
  }
  /** @see https://tc39.es/ecma262/#sec-%typedarray%.prototype.slice */
  slice(start, end) {
    assertFloat16Array(this);
    const float16bitsArray = getFloat16BitsArray(this);
    const Constructor = SpeciesConstructor(float16bitsArray, _Float16Array);
    if (Constructor === _Float16Array) {
      const uint16 = new NativeUint16Array(
        TypedArrayPrototypeGetBuffer(float16bitsArray),
        TypedArrayPrototypeGetByteOffset(float16bitsArray),
        TypedArrayPrototypeGetLength(float16bitsArray)
      );
      return new _Float16Array(
        TypedArrayPrototypeGetBuffer(
          TypedArrayPrototypeSlice(uint16, start, end)
        )
      );
    }
    const length = TypedArrayPrototypeGetLength(float16bitsArray);
    const relativeStart = ToIntegerOrInfinity(start);
    const relativeEnd = end === void 0 ? length : ToIntegerOrInfinity(end);
    let k;
    if (relativeStart === -Infinity) {
      k = 0;
    } else if (relativeStart < 0) {
      k = length + relativeStart > 0 ? length + relativeStart : 0;
    } else {
      k = length < relativeStart ? length : relativeStart;
    }
    let final;
    if (relativeEnd === -Infinity) {
      final = 0;
    } else if (relativeEnd < 0) {
      final = length + relativeEnd > 0 ? length + relativeEnd : 0;
    } else {
      final = length < relativeEnd ? length : relativeEnd;
    }
    const count = final - k > 0 ? final - k : 0;
    const array = new Constructor(count);
    assertSpeciesTypedArray(array, count);
    if (count === 0) {
      return array;
    }
    const buffer2 = TypedArrayPrototypeGetBuffer(float16bitsArray);
    if (IsDetachedBuffer(buffer2)) {
      throw NativeTypeError(ATTEMPTING_TO_ACCESS_DETACHED_ARRAYBUFFER);
    }
    let n = 0;
    while (k < final) {
      array[n] = convertToNumber(float16bitsArray[k]);
      ++k;
      ++n;
    }
    return (
      /** @type {any} */
      array
    );
  }
  /** @see https://tc39.es/ecma262/#sec-%typedarray%.prototype.subarray */
  subarray(begin, end) {
    assertFloat16Array(this);
    const float16bitsArray = getFloat16BitsArray(this);
    const Constructor = SpeciesConstructor(float16bitsArray, _Float16Array);
    const uint16 = new NativeUint16Array(
      TypedArrayPrototypeGetBuffer(float16bitsArray),
      TypedArrayPrototypeGetByteOffset(float16bitsArray),
      TypedArrayPrototypeGetLength(float16bitsArray)
    );
    const uint16Subarray = TypedArrayPrototypeSubarray(uint16, begin, end);
    const array = new Constructor(
      TypedArrayPrototypeGetBuffer(uint16Subarray),
      TypedArrayPrototypeGetByteOffset(uint16Subarray),
      TypedArrayPrototypeGetLength(uint16Subarray)
    );
    assertSpeciesTypedArray(array);
    return (
      /** @type {any} */
      array
    );
  }
  /** @see https://tc39.es/ecma262/#sec-%typedarray%.prototype.indexof */
  indexOf(element, ...opts) {
    assertFloat16Array(this);
    const float16bitsArray = getFloat16BitsArray(this);
    const length = TypedArrayPrototypeGetLength(float16bitsArray);
    let from = ToIntegerOrInfinity(opts[0]);
    if (from === Infinity) {
      return -1;
    }
    if (from < 0) {
      from += length;
      if (from < 0) {
        from = 0;
      }
    }
    for (let i = from; i < length; ++i) {
      if (ObjectHasOwn(float16bitsArray, i) && convertToNumber(float16bitsArray[i]) === element) {
        return i;
      }
    }
    return -1;
  }
  /** @see https://tc39.es/ecma262/#sec-%typedarray%.prototype.lastindexof */
  lastIndexOf(element, ...opts) {
    assertFloat16Array(this);
    const float16bitsArray = getFloat16BitsArray(this);
    const length = TypedArrayPrototypeGetLength(float16bitsArray);
    let from = opts.length >= 1 ? ToIntegerOrInfinity(opts[0]) : length - 1;
    if (from === -Infinity) {
      return -1;
    }
    if (from >= 0) {
      from = from < length - 1 ? from : length - 1;
    } else {
      from += length;
    }
    for (let i = from; i >= 0; --i) {
      if (ObjectHasOwn(float16bitsArray, i) && convertToNumber(float16bitsArray[i]) === element) {
        return i;
      }
    }
    return -1;
  }
  /** @see https://tc39.es/ecma262/#sec-%typedarray%.prototype.includes */
  includes(element, ...opts) {
    assertFloat16Array(this);
    const float16bitsArray = getFloat16BitsArray(this);
    const length = TypedArrayPrototypeGetLength(float16bitsArray);
    let from = ToIntegerOrInfinity(opts[0]);
    if (from === Infinity) {
      return false;
    }
    if (from < 0) {
      from += length;
      if (from < 0) {
        from = 0;
      }
    }
    const isNaN = NumberIsNaN(element);
    for (let i = from; i < length; ++i) {
      const value = convertToNumber(float16bitsArray[i]);
      if (isNaN && NumberIsNaN(value)) {
        return true;
      }
      if (value === element) {
        return true;
      }
    }
    return false;
  }
  /** @see https://tc39.es/ecma262/#sec-%typedarray%.prototype.join */
  join(separator) {
    assertFloat16Array(this);
    const float16bitsArray = getFloat16BitsArray(this);
    const array = copyToArray(float16bitsArray);
    return ArrayPrototypeJoin(array, separator);
  }
  /** @see https://tc39.es/ecma262/#sec-%typedarray%.prototype.tolocalestring */
  toLocaleString(...opts) {
    assertFloat16Array(this);
    const float16bitsArray = getFloat16BitsArray(this);
    const array = copyToArray(float16bitsArray);
    return ArrayPrototypeToLocaleString(array, ...safeIfNeeded(opts));
  }
  /** @see https://tc39.es/ecma262/#sec-get-%typedarray%.prototype-@@tostringtag */
  get [SymbolToStringTag]() {
    if (isFloat16Array(this)) {
      return (
        /** @type {any} */
        "Float16Array"
      );
    }
  }
};
ObjectDefineProperty(Float16Array, "BYTES_PER_ELEMENT", {
  value: BYTES_PER_ELEMENT
});
ObjectDefineProperty(Float16Array, brand, {});
ReflectSetPrototypeOf(Float16Array, TypedArray);
var Float16ArrayPrototype = Float16Array.prototype;
ObjectDefineProperty(Float16ArrayPrototype, "BYTES_PER_ELEMENT", {
  value: BYTES_PER_ELEMENT
});
ObjectDefineProperty(Float16ArrayPrototype, SymbolIterator, {
  value: Float16ArrayPrototype.values,
  writable: true,
  configurable: true
});
ReflectSetPrototypeOf(Float16ArrayPrototype, TypedArrayPrototype);

// node_modules/oidn-webgpu/lib/webnnUNet.js
var interopPipelinesByDevice = /* @__PURE__ */ new WeakMap();
function interopPipelines(device, sourceCount) {
  let bySourceCount = interopPipelinesByDevice.get(device);
  if (!bySourceCount) {
    bySourceCount = /* @__PURE__ */ new Map();
    interopPipelinesByDevice.set(device, bySourceCount);
  }
  let pipelines = bySourceCount.get(sourceCount);
  if (!pipelines) {
    const inputModule = device.createShaderModule({
      label: `oidn/webnn/input-pack/${sourceCount}`,
      code: createInputPackShader2(sourceCount)
    });
    const outputModule = device.createShaderModule({
      label: "oidn/webnn/output-unpack",
      code: createOutputUnpackShader()
    });
    pipelines = {
      input: device.createComputePipeline({
        label: `oidn/webnn/input-pack/${sourceCount}`,
        layout: "auto",
        compute: { module: inputModule, entryPoint: "main" }
      }),
      output: device.createComputePipeline({
        label: "oidn/webnn/output-unpack",
        layout: "auto",
        compute: { module: outputModule, entryPoint: "main" }
      })
    };
    bySourceCount.set(sourceCount, pipelines);
  }
  return pipelines;
}
var WORKGROUP_SIZE4 = 8;
function roundUp2(value, alignment) {
  return Math.ceil(value / alignment) * alignment;
}
function createMappedBuffer2(device, label, data, usage) {
  const buffer2 = device.createBuffer({
    label,
    size: roundUp2(data.byteLength, 4),
    usage,
    mappedAtCreation: true
  });
  new Uint8Array(buffer2.getMappedRange()).set(new Uint8Array(data.buffer, data.byteOffset, data.byteLength));
  buffer2.unmap();
  return buffer2;
}
function uniformBuffer(device, label, values2) {
  const data = new Uint32Array(roundUp2(values2.length, 4));
  data.set(values2);
  return createMappedBuffer2(device, label, data, GPUBufferUsage.UNIFORM);
}
function hasDataType(limits, op, operand, dataType) {
  return Boolean(limits?.[op]?.[operand]?.dataTypes?.includes?.(dataType));
}
function tensorBytes(tensor, precision) {
  if (precision === "fp16" && tensor.desc.dataType === "Float16") {
    return new Uint8Array(tensor.data.buffer, tensor.data.byteOffset, tensor.data.byteLength);
  }
  if (precision === "fp32" && tensor.desc.dataType === "Float32") {
    return new Uint8Array(tensor.data.buffer, tensor.data.byteOffset, tensor.data.byteLength);
  }
  const source = tensor.desc.dataType === "Float32" ? new Float32Array(tensor.data.buffer, tensor.data.byteOffset, tensor.data.byteLength / 4) : new Float16Array(tensor.data.buffer, tensor.data.byteOffset, tensor.data.byteLength / 2);
  const converted = precision === "fp16" ? new Float16Array(source) : new Float32Array(source);
  return new Uint8Array(converted.buffer, converted.byteOffset, converted.byteLength);
}
function createInputPackShader2(sourceCount) {
  const sources = Array.from({ length: sourceCount }, (_, index) => `@group(0) @binding(${index}) var<storage, read> input${index}: array<vec4<f32>>;`).join("\n");
  const branches = Array.from({ length: sourceCount }, (_, index) => {
    const firstChannel = index * 3;
    return `if (channel < ${firstChannel + 3}u) {
      return input${index}[pixel][channel - ${firstChannel}u];
    }`;
  }).join("\n  ");
  return (
    /* wgsl */
    `enable f16;
struct Params { width: u32, height: u32, channels: u32, padding: u32 }
${sources}
@group(0) @binding(${sourceCount}) var<storage, read_write> outputData: array<f16>;
@group(0) @binding(${sourceCount + 1}) var<uniform> params: Params;

fn readChannel(pixel: u32, channel: u32) -> f32 {
  ${branches}
  return 0.0;
}

@compute @workgroup_size(${WORKGROUP_SIZE4}, ${WORKGROUP_SIZE4}, 1)
fn main(@builtin(global_invocation_id) gid: vec3<u32>) {
  if (gid.x >= params.width || gid.y >= params.height || gid.z >= params.channels) {
    return;
  }
  let pixel = gid.y * params.width + gid.x;
  let outputIndex = (gid.z * params.height + gid.y) * params.width + gid.x;
  outputData[outputIndex] = f16(readChannel(pixel, gid.z));
}
`
  );
}
function createOutputUnpackShader() {
  return (
    /* wgsl */
    `enable f16;
struct Params { width: u32, height: u32, padding0: u32, padding1: u32 }
@group(0) @binding(0) var<storage, read> inputData: array<f16>;
@group(0) @binding(1) var<storage, read_write> outputData: array<vec4<f32>>;
@group(0) @binding(2) var<uniform> params: Params;

@compute @workgroup_size(${WORKGROUP_SIZE4}, ${WORKGROUP_SIZE4}, 1)
fn main(@builtin(global_invocation_id) gid: vec3<u32>) {
  if (gid.x >= params.width || gid.y >= params.height) { return; }
  let pixel = gid.y * params.width + gid.x;
  let plane = params.width * params.height;
  outputData[pixel] = vec4<f32>(
    f32(inputData[pixel]),
    f32(inputData[plane + pixel]),
    f32(inputData[plane * 2u + pixel]),
    0.0
  );
}
`
  );
}
function resolveWebNNPrecision(device, requested) {
  if (requested === "fp32") {
    throw new Error("OIDN WebNN GPU interop currently requires FP16 exportable tensors");
  }
  if (!device.features.has("shader-f16")) {
    throw new Error("OIDN WebNN requires shader-f16 on the shared GPUDevice");
  }
  return "fp16";
}
function activation(builder, operand, kind) {
  return kind === "relu" ? builder.relu(operand) : operand;
}
var WebNNUNetExecutor = class {
  _device;
  _model;
  precision;
  support;
  _context;
  _builderConstructor;
  _shapeCache = /* @__PURE__ */ new Map();
  _shapePromises = /* @__PURE__ */ new Map();
  _retiredExecutions = /* @__PURE__ */ new Set();
  _pendingCreationCount = 0;
  _shapeCacheSize;
  _clock = 0;
  _inputPipeline;
  _outputPipeline;
  _resources = new OIDNResourceTracker();
  _disposed = false;
  constructor(_device, _model, options = {}) {
    this._device = _device;
    this._model = _model;
    this.precision = resolveWebNNPrecision(_device, options.precision ?? "auto");
    this._shapeCacheSize = Math.max(1, options.shapeCacheSize ?? 2);
    this.support = {
      available: false,
      fp16Conv: false,
      gpuInterop: false
    };
    const pipelines = interopPipelines(_device, _model.inputChannels / 3);
    this._inputPipeline = pipelines.input;
    this._outputPipeline = pipelines.output;
  }
  async prepare() {
    if (this._disposed)
      throw new Error("OIDN WebNN executor is disposed");
    const webNN = globalThis.navigator?.ml;
    const Builder = globalThis.MLGraphBuilder;
    if (!webNN?.createContext || typeof Builder !== "function") {
      this.support.reason = "WebNN is not exposed by this browser";
      throw new Error(this.support.reason);
    }
    this._builderConstructor = Builder;
    try {
      try {
        this._context = await webNN.createContext({
          deviceType: "gpu",
          powerPreference: "high-performance"
        });
      } catch {
        this._context = await webNN.createContext({ deviceType: "gpu" });
      }
      this._resources.track("ml-context", this._context);
      if (this._disposed)
        throw new Error("OIDN WebNN executor is disposed");
      if (typeof this._context.createExportableTensor !== "function" || typeof this._context.exportToGPU !== "function") {
        this.support.reason = "WebNN WebGPU tensor interop is unavailable";
        throw new Error(this.support.reason);
      }
      const limits = this._context.opSupportLimits?.() ?? {};
      this.support.fp16Conv = hasDataType(limits, "conv2d", "input", "float16") && hasDataType(limits, "conv2d", "filter", "float16") && hasDataType(limits, "conv2d", "output", "float16");
      if (!this.support.fp16Conv) {
        this.support.reason = "WebNN does not support FP16 conv2d";
        throw new Error(this.support.reason);
      }
      let probe;
      let probeBuffer;
      try {
        probe = this._resources.track("ml-tensor", await this._context.createExportableTensor({ dataType: "float16", shape: [4] }, this._device));
        probeBuffer = this._resources.track("gpu-buffer", await this._context.exportToGPU(probe));
        this.support.gpuInterop = true;
      } catch (error) {
        this.support.reason = `WebNN FP16 WebGPU interop failed: ${String(error)}`;
        throw new Error(this.support.reason);
      } finally {
        this._releaseBuffer(probeBuffer);
        this._releaseTensor(probe);
      }
      this.support.available = true;
    } catch (error) {
      this._releaseContext();
      throw error;
    }
  }
  _constant(builder, tensor) {
    return builder.constant({
      dataType: "float16",
      shape: [...tensor.desc.dims]
    }, tensorBytes(tensor, this.precision));
  }
  async _createExecution(width, height) {
    if (this._disposed)
      throw new Error("OIDN WebNN executor is disposed");
    const builder = new this._builderConstructor(this._context);
    const values2 = /* @__PURE__ */ new Map();
    const shapes = /* @__PURE__ */ new Map();
    values2.set(this._model.spec.input, builder.input("input", {
      dataType: "float16",
      shape: [1, this._model.inputChannels, height, width]
    }));
    shapes.set(this._model.spec.input, [this._model.inputChannels, height, width]);
    for (const node of this._model.spec.nodes) {
      let result;
      let shape;
      if (node.op === "conv2d") {
        const inputShape = shapes.get(node.input);
        const tensors = this._model.convTensors.get(node.id);
        const convolution = builder.conv2d(values2.get(node.input), this._constant(builder, tensors.weight), {
          bias: this._constant(builder, tensors.bias),
          padding: [1, 1, 1, 1],
          inputLayout: "nchw",
          filterLayout: "oihw"
        });
        result = activation(builder, convolution, node.activation);
        shape = [tensors.outputChannels, inputShape[1], inputShape[2]];
      } else if (node.op === "maxPool2d") {
        const inputShape = shapes.get(node.input);
        result = builder.maxPool2d(values2.get(node.input), {
          windowDimensions: [2, 2],
          strides: [2, 2],
          padding: [0, inputShape[1] % 2, 0, inputShape[2] % 2],
          layout: "nchw"
        });
        shape = [
          inputShape[0],
          Math.ceil(inputShape[1] / 2),
          Math.ceil(inputShape[2] / 2)
        ];
      } else if (node.op === "upsample2d") {
        const inputShape = shapes.get(node.input);
        result = builder.resample2d(values2.get(node.input), {
          mode: "nearest-neighbor",
          axes: [2, 3],
          scales: [2, 2]
        });
        shape = [inputShape[0], inputShape[1] * 2, inputShape[2] * 2];
      } else {
        const inputShapes = node.inputs.map((input) => shapes.get(input));
        if (inputShapes.some((candidate) => candidate[1] !== inputShapes[0][1] || candidate[2] !== inputShapes[0][2])) {
          throw new Error(`WebNN concat ${node.id} has mismatched spatial shapes`);
        }
        result = builder.concat(node.inputs.map((input) => values2.get(input)), 1);
        shape = [
          inputShapes.reduce((sum, candidate) => sum + candidate[0], 0),
          inputShapes[0][1],
          inputShapes[0][2]
        ];
      }
      values2.set(node.id, result);
      shapes.set(node.id, shape);
    }
    let graph;
    let inputTensor;
    let outputTensor;
    let outputBuffer;
    let inputUniform;
    let outputUniform;
    try {
      graph = this._resources.track("ml-graph", await builder.build({
        output: values2.get(this._model.spec.output)
      }));
      inputTensor = this._resources.track("ml-tensor", await this._context.createExportableTensor({
        dataType: "float16",
        shape: [1, this._model.inputChannels, height, width],
        writable: true
      }, this._device));
      outputTensor = this._resources.track("ml-tensor", await this._context.createExportableTensor({
        dataType: "float16",
        shape: [1, this._model.outputChannels, height, width],
        readable: true
      }, this._device));
      outputBuffer = this._resources.track("gpu-buffer", this._device.createBuffer({
        label: `oidn/webnn/output/${width}x${height}`,
        size: width * height * 4 * 4,
        usage: GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_SRC | GPUBufferUsage.COPY_DST
      }));
      inputUniform = this._resources.track("gpu-buffer", uniformBuffer(this._device, `oidn/webnn/input/${width}x${height}`, [width, height, this._model.inputChannels]));
      outputUniform = this._resources.track("gpu-buffer", uniformBuffer(this._device, `oidn/webnn/output/${width}x${height}`, [width, height]));
      const execution = {
        graph,
        inputTensor,
        outputTensor,
        outputBuffer,
        inputUniform,
        outputUniform,
        width,
        height,
        lastUsed: ++this._clock
      };
      return execution;
    } catch (error) {
      this._releaseBuffer(outputUniform);
      this._releaseBuffer(inputUniform);
      this._releaseBuffer(outputBuffer);
      this._releaseTensor(outputTensor);
      this._releaseTensor(inputTensor);
      this._releaseGraph(graph);
      throw error;
    }
  }
  async _execution(width, height) {
    const key = `${width}x${height}`;
    let execution = this._shapeCache.get(key);
    if (!execution) {
      let pending = this._shapePromises.get(key);
      if (!pending) {
        pending = (async () => {
          this._pendingCreationCount++;
          try {
            return await this._createExecution(width, height);
          } finally {
            this._pendingCreationCount--;
          }
        })();
        this._shapePromises.set(key, pending);
      }
      try {
        execution = await pending;
        if (this._disposed) {
          this._destroyExecution(execution);
          throw new Error("OIDN WebNN executor is disposed");
        }
        this._shapeCache.set(key, execution);
      } finally {
        if (this._shapePromises.get(key) === pending) {
          this._shapePromises.delete(key);
        }
      }
      if (this._shapeCache.size > this._shapeCacheSize) {
        const oldest = [...this._shapeCache.entries()].filter(([candidate]) => candidate !== key).sort((left, right) => left[1].lastUsed - right[1].lastUsed)[0];
        if (oldest) {
          this._shapeCache.delete(oldest[0]);
          this._retireExecution(oldest[1]);
        }
      }
    }
    execution.lastUsed = ++this._clock;
    return execution;
  }
  /** Compiles common tile shapes while the host still reports model loading. */
  async prewarm(shapes) {
    for (const shape of shapes) {
      await this._execution(shape.width, shape.height);
    }
  }
  async execute(inputBuffers, width, height) {
    const sourceCount = this._model.inputChannels / 3;
    if (inputBuffers.length !== sourceCount) {
      throw new Error(`OIDN WebNN expected ${sourceCount} input buffers, got ${inputBuffers.length}`);
    }
    const execution = await this._execution(width, height);
    const inputGPUBuffer = this._resources.track("gpu-buffer", await this._context.exportToGPU(execution.inputTensor));
    try {
      const inputEntries = inputBuffers.map((buffer2, binding) => ({ binding, resource: { buffer: buffer2 } }));
      inputEntries.push({
        binding: sourceCount,
        resource: { buffer: inputGPUBuffer }
      });
      inputEntries.push({
        binding: sourceCount + 1,
        resource: { buffer: execution.inputUniform }
      });
      const inputBindGroup = this._device.createBindGroup({
        label: "oidn/webnn/input-bindings",
        layout: this._inputPipeline.getBindGroupLayout(0),
        entries: inputEntries
      });
      const inputEncoder = this._device.createCommandEncoder({
        label: "oidn/webnn/input-pack"
      });
      const inputPass = inputEncoder.beginComputePass();
      inputPass.setPipeline(this._inputPipeline);
      inputPass.setBindGroup(0, inputBindGroup);
      inputPass.dispatchWorkgroups(Math.ceil(width / WORKGROUP_SIZE4), Math.ceil(height / WORKGROUP_SIZE4), this._model.inputChannels);
      inputPass.end();
      this._device.queue.submit([inputEncoder.finish()]);
    } finally {
      this._releaseBuffer(inputGPUBuffer);
    }
    this._context.dispatch(execution.graph, { input: execution.inputTensor }, { output: execution.outputTensor });
    const outputGPUBuffer = this._resources.track("gpu-buffer", await this._context.exportToGPU(execution.outputTensor));
    try {
      const outputBindGroup = this._device.createBindGroup({
        label: "oidn/webnn/output-bindings",
        layout: this._outputPipeline.getBindGroupLayout(0),
        entries: [
          { binding: 0, resource: { buffer: outputGPUBuffer } },
          { binding: 1, resource: { buffer: execution.outputBuffer } },
          { binding: 2, resource: { buffer: execution.outputUniform } }
        ]
      });
      const outputEncoder = this._device.createCommandEncoder({
        label: "oidn/webnn/output-unpack"
      });
      const outputPass = outputEncoder.beginComputePass();
      outputPass.setPipeline(this._outputPipeline);
      outputPass.setBindGroup(0, outputBindGroup);
      outputPass.dispatchWorkgroups(Math.ceil(width / WORKGROUP_SIZE4), Math.ceil(height / WORKGROUP_SIZE4));
      outputPass.end();
      this._device.queue.submit([outputEncoder.finish()]);
    } finally {
      this._releaseBuffer(outputGPUBuffer);
    }
    return execution.outputBuffer;
  }
  async executeCPU(input, width, height) {
    const execution = await this._execution(width, height);
    const plane = width * height;
    const packed = new Float16Array(plane * this._model.inputChannels);
    for (let pixel = 0; pixel < plane; pixel++) {
      for (let channel = 0; channel < this._model.inputChannels; channel++) {
        packed[channel * plane + pixel] = input[pixel * this._model.inputChannels + channel];
      }
    }
    this._context.writeTensor(execution.inputTensor, packed);
    this._context.dispatch(execution.graph, { input: execution.inputTensor }, { output: execution.outputTensor });
    const result = new Float16Array(await this._context.readTensor(execution.outputTensor));
    const unpacked = new Float32Array(plane * this._model.outputChannels);
    for (let pixel = 0; pixel < plane; pixel++) {
      for (let channel = 0; channel < this._model.outputChannels; channel++) {
        unpacked[pixel * this._model.outputChannels + channel] = result[channel * plane + pixel];
      }
    }
    return unpacked;
  }
  _destroyExecution(execution) {
    this._releaseGraph(execution.graph);
    this._releaseTensor(execution.inputTensor);
    this._releaseTensor(execution.outputTensor);
    this._releaseBuffer(execution.outputBuffer);
    this._releaseBuffer(execution.inputUniform);
    this._releaseBuffer(execution.outputUniform);
  }
  _retireExecution(execution) {
    this._retiredExecutions.add(execution);
    void this._device.queue.onSubmittedWorkDone().catch(() => void 0).then(() => {
      this._retiredExecutions.delete(execution);
      this._destroyExecution(execution);
    });
  }
  _releaseBuffer(buffer2) {
    this._resources.release("gpu-buffer", buffer2, () => buffer2.destroy());
  }
  _releaseTensor(tensor) {
    this._resources.release("ml-tensor", tensor, () => tensor.destroy());
  }
  _releaseGraph(graph) {
    this._resources.release("ml-graph", graph, () => graph.destroy?.());
  }
  _releaseContext() {
    this._resources.release("ml-context", this._context, () => this._context.destroy?.());
  }
  getResourceInfo() {
    return this._resources.snapshot(this._pendingCreationCount + this._retiredExecutions.size);
  }
  dispose() {
    if (this._disposed)
      return;
    this._disposed = true;
    for (const execution of this._shapeCache.values()) {
      this._destroyExecution(execution);
    }
    this._shapeCache.clear();
    for (const execution of this._retiredExecutions) {
      this._destroyExecution(execution);
    }
    this._retiredExecutions.clear();
    this._shapePromises.clear();
    this._releaseContext();
  }
};

// node_modules/oidn-webgpu/lib/UNet.js
var ANIMATION_FRAME_FALLBACK_MS = 100;
function roundUp3(a2, b2) {
  return Math.ceil(a2 / b2) * b2;
}
function isGPUImageData(data) {
  return data.data instanceof GPUBuffer || data.data instanceof GPUTexture;
}
var UNet = class {
  _device;
  _aux;
  _hdr;
  _hdrTransfer;
  _dataProcessGPU;
  _nativeExecutor;
  _webNNExecutor;
  _modelSpec;
  _inputChannels;
  _engine;
  _dynamicTileController;
  _lastExecution;
  _profileNextImage = false;
  _lastImageProfile;
  _activeExecutionFailures = /* @__PURE__ */ new Set();
  _deviceLostObserved = false;
  _deviceLostSettled = false;
  _deviceLostReason;
  constructor(hostTensors, device, opts = {}) {
    this._aux = opts.aux || false;
    this._hdr = opts.hdr || false;
    this._hdrTransfer = opts.hdrTransfer ?? "pu";
    this._engine = opts.engine ?? "auto";
    const modelSpec = opts.modelSpec ?? detectUNetModelSpec(hostTensors);
    const validatedModel = validateUNetModel(hostTensors, modelSpec);
    this._modelSpec = validatedModel.spec;
    this._inputChannels = validatedModel.inputChannels;
    const expectedInputChannels = this._aux ? 9 : 3;
    if (validatedModel.inputChannels !== expectedInputChannels) {
      throw new Error(`OIDN model expects ${validatedModel.inputChannels} input channels, but aux=${this._aux} provides ${expectedInputChannels}`);
    }
    this._dynamicTileController = new DynamicTileController(opts.maxTileSize ?? 512, opts.dynamicTile);
    this._device = device;
    this._observeDeviceLoss();
    if (this._engine === "webnn") {
      this._webNNExecutor = new WebNNUNetExecutor(this._device, validatedModel, { precision: opts.precision });
    } else {
      this._nativeExecutor = new NativeUNetExecutor(this._device, validatedModel, {
        precision: opts.precision,
        kernel: opts.kernel,
        gemm: opts.gemm,
        subgroupMatrix: opts.subgroupMatrix
      });
    }
  }
  getDevice() {
    return this._device;
  }
  /** Completes backend compilation before first interactive use. */
  async prepare() {
    if (this._webNNExecutor) {
      await this._webNNExecutor.prepare();
      const overlap = roundUp3(this._modelSpec.receptiveField / 2, OIDN_TILE_ALIGNMENT);
      const outputTileEdges = [
        this._dynamicTileController.tileSize,
        this._dynamicTileController.minTileSize
      ];
      await this._webNNExecutor.prewarm([...new Set(outputTileEdges)].map((edge) => ({
        width: edge + 2 * overlap,
        height: edge + 2 * overlap
      })));
      return;
    }
    await this._nativeExecutor.prepare();
  }
  /**
   * Prepares the input shapes selected for an image before its first denoise.
   * Hosts can call this while they still display their model-loading state.
   */
  async prepareForImage(width, height, options = {}) {
    const defaultTileOverlap = roundUp3(this._modelSpec.receptiveField / 2, OIDN_TILE_ALIGNMENT);
    const resolvedTileOverlap = options.tileOverlap === void 0 ? defaultTileOverlap : roundUp3(Math.max(0, options.tileOverlap), OIDN_TILE_ALIGNMENT);
    const plan = planTileGrid(width, height, options.wholeImage ? roundUp3(Math.max(width, height), OIDN_TILE_ALIGNMENT) : this._dynamicTileController.tileSize, resolvedTileOverlap);
    const shapes = [...new Map(plan.tiles.map(({ input }) => [
      `${input.width}x${input.height}`,
      { width: input.width, height: input.height }
    ])).values()];
    await this._webNNExecutor?.prewarm(shapes);
    this._nativeExecutor?.prewarm(shapes);
  }
  getRuntimeInfo() {
    return {
      configuredEngine: this._engine,
      gpuEngine: this._webNNExecutor ? "webnn" : "wgsl",
      precision: (this._webNNExecutor ?? this._nativeExecutor).precision,
      kernel: this._nativeExecutor ? {
        configured: this._nativeExecutor.kernelSetting,
        gemm: this._nativeExecutor.gemm,
        maxSpatialInputBlocks: this._nativeExecutor.maxSpatialInputBlocks,
        subgroupsAvailable: this._nativeExecutor.subgroupsAvailable,
        subgroupMatrix: this._nativeExecutor.subgroupMatrix
      } : void 0,
      webnn: this._webNNExecutor?.support,
      resources: (this._webNNExecutor ?? this._nativeExecutor).getResourceInfo(),
      model: this._modelSpec.id,
      modelFamily: this._modelSpec.family,
      inputChannels: this._inputChannels,
      hdrTransfer: this._hdrTransfer,
      dynamicTile: {
        enabled: this._dynamicTileController.enabled,
        currentTileSize: this._dynamicTileController.tileSize,
        minTileSize: this._dynamicTileController.minTileSize,
        maxTileSize: this._dynamicTileController.maxTileSize,
        targetTileTimeMs: this._dynamicTileController.targetTileTimeMs
      },
      lastExecution: this._lastExecution,
      activeExecutionCount: this._activeExecutionFailures.size
    };
  }
  _observeDeviceLoss() {
    this._activeExecutionFailures ??= /* @__PURE__ */ new Set();
    if (this._deviceLostObserved)
      return;
    this._deviceLostObserved = true;
    const deviceLost = this._device.lost;
    if (!deviceLost)
      return;
    const failAll = (reason) => {
      if (this._deviceLostSettled)
        return;
      this._deviceLostSettled = true;
      this._deviceLostReason = reason;
      const active = [...this._activeExecutionFailures];
      this._activeExecutionFailures.clear();
      for (const fail of active)
        fail(reason);
    };
    void deviceLost.then((info) => failAll(new Error(`WebGPU device lost: ${info.message}`)), failAll);
  }
  _registerExecutionFailure(fail) {
    this._observeDeviceLoss();
    this._activeExecutionFailures.add(fail);
    if (this._deviceLostSettled) {
      this._activeExecutionFailures.delete(fail);
      queueMicrotask(() => fail(this._deviceLostReason));
    }
    return () => this._activeExecutionFailures.delete(fail);
  }
  /** Captures network GPU timestamps across every tile of the next image. */
  profileNextExecution() {
    if (!this._nativeExecutor || !this._device.features.has("timestamp-query"))
      return false;
    this._profileNextImage = true;
    return true;
  }
  getLastExecutionProfile() {
    return this._lastImageProfile ? Promise.resolve(this._lastImageProfile) : void 0;
  }
  _processImageData(color, albedo, normal, isHDR) {
    const rawData = color.data;
    const pixelsCount = rawData.length / 4;
    const channels = this._aux ? 9 : 3;
    const tensorData = new Float32Array(pixelsCount * channels);
    if (albedo && !normal || normal && !albedo) {
      throw new Error("Normal map and albedo map are both required");
    }
    if (albedo && normal) {
      if (albedo.width !== normal.width || albedo.height !== normal.height || color.width !== albedo.width || color.height !== albedo.height) {
        throw new Error("Image size mismatch");
      }
    }
    const albedoData = albedo?.data;
    const normalData = normal?.data;
    const albedoDivisor = albedoData instanceof Float32Array ? 1 : 255;
    const normalDivisor = normalData instanceof Float32Array ? 1 : 255;
    for (let i = 0; i < rawData.length; i += 4) {
      const i2 = i / 4 * channels;
      for (let c2 = 0; c2 < 3; c2++) {
        if (isHDR) {
          tensorData[i2 + c2] = rawData[i + c2];
        } else {
          tensorData[i2 + c2] = rawData[i + c2] / 255;
        }
        if (albedoData) {
          tensorData[i2 + c2 + 3] = albedoData[i + c2] / albedoDivisor;
        }
        if (normalData) {
          tensorData[i2 + c2 + 6] = normalData[i + c2] / normalDivisor;
        }
      }
    }
    return tensorData;
  }
  _processCPUTile(data, channels, srcTile, width, height, isHDR) {
    const validWidth = Math.min(srcTile.width, width - srcTile.x);
    const validHeight = Math.min(srcTile.height, height - srcTile.y);
    const rowLength = validWidth * channels;
    let tileData = new Float32Array(rowLength * validHeight);
    for (let y = 0; y < validHeight; y++) {
      const start = ((y + srcTile.y) * width + srcTile.x) * channels;
      tileData.set(data.subarray(start, start + rowLength), y * rowLength);
    }
    let inputScale = 1;
    if (isHDR) {
      inputScale = avgLogLum({ data: tileData, channels });
      tileData = hdrTransferFuncCPU({
        data: tileData,
        channels,
        inputScale,
        transfer: this._hdrTransfer
      });
    }
    if (validWidth !== srcTile.width || validHeight !== srcTile.height) {
      const stride = srcTile.width * channels;
      const padded = new Float32Array(stride * srcTile.height);
      for (let y = 0; y < validHeight; y++) {
        const start = y * rowLength;
        padded.set(tileData.subarray(start, start + rowLength), y * stride);
      }
      tileData = padded;
    }
    return { tileData, inputScale };
  }
  _writeTile(imageData, srcTile, dstTile, srcTileData, srcWidth, isHDR) {
    const { data: outImageData, width } = imageData;
    const dx = dstTile.x - srcTile.x;
    const dy = dstTile.y - srcTile.y;
    for (let y = 0; y < dstTile.height; y++) {
      for (let x = 0; x < dstTile.width; x++) {
        const i1 = ((y + dy) * srcWidth + x + dx) * 3;
        const i2 = ((y + dstTile.y) * width + (x + dstTile.x)) * 4;
        for (let c2 = 0; c2 < 3; c2++) {
          if (isHDR) {
            outImageData[i2 + c2] = srcTileData[i1 + c2];
          } else {
            outImageData[i2 + c2] = Math.min(Math.max(srcTileData[i1 + c2] * 255, 0), 255);
          }
        }
        imageData.data[i2 + 3] = isHDR ? 1 : 255;
      }
    }
  }
  async _executeTile(inputData, outputTileData, outputImageData, tile, isFirstTile, width, height, isHDR, denoiseAlpha) {
    const channels = this._aux ? 9 : 3;
    const srcTile = new Tile(tile.input.x, tile.input.y, tile.input.width, tile.input.height);
    const dstTile = new Tile(tile.output.x, tile.output.y, tile.output.width, tile.output.height);
    const srcTileWidth = srcTile.width;
    const srcTileHeight = srcTile.height;
    let nativeOutputBuffer;
    let denoisedData;
    let inputScale = 1;
    const device = this._device;
    let dataProcessGPU = this._dataProcessGPU;
    if (inputData instanceof Float32Array) {
      const prepared = this._processCPUTile(inputData, channels, srcTile, width, height, isHDR);
      inputScale = prepared.inputScale;
      denoisedData = await (this._webNNExecutor ?? this._nativeExecutor).executeCPU(prepared.tileData, srcTileWidth, srcTileHeight);
    } else {
      if (!dataProcessGPU) {
        dataProcessGPU = this._dataProcessGPU = new GPUDataProcess(device, isHDR, this._hdrTransfer);
      }
      dataProcessGPU.setImageSize(width, height);
      dataProcessGPU.setInputTile(srcTile);
      if (isFirstTile) {
        dataProcessGPU.copyInputDataToOutput(inputData.color);
      }
      const { color, albedo, normal } = dataProcessGPU.forward(inputData.color, this._aux ? inputData.albedo : void 0, this._aux ? inputData.normal : void 0, denoiseAlpha);
      nativeOutputBuffer = await (this._webNNExecutor ?? this._nativeExecutor).execute(this._aux ? [color, albedo, normal] : [color], srcTileWidth, srcTileHeight);
    }
    let outBuffer;
    if (inputData instanceof Float32Array) {
      if (isHDR) {
        denoisedData = hdrTransferFuncInverseCPU({
          data: denoisedData,
          channels: 3,
          inputScale,
          transfer: this._hdrTransfer
        });
      }
      this._writeTile(outputImageData, srcTile, dstTile, denoisedData, srcTile.width, isHDR);
      for (let y = 0; y < dstTile.height; y++) {
        for (let x = 0; x < dstTile.width; x++) {
          const i1 = (y * dstTile.width + x) * 4;
          const i2 = ((y + dstTile.y) * width + (x + dstTile.x)) * 4;
          for (let c2 = 0; c2 < 4; c2++) {
            outputTileData.data[i1 + c2] = outputImageData.data[i2 + c2];
          }
        }
      }
    } else {
      dataProcessGPU.setOutputTile(dstTile, srcTile);
      outBuffer = dataProcessGPU.inverse(nativeOutputBuffer, inputData.color);
    }
    return outBuffer;
  }
  tileExecute({ color, albedo, normal, done, progress, denoiseAlpha, tileOverlap, wholeImage, scheduling = "event-loop", error }) {
    if (this._aux && (!albedo || !normal)) {
      throw new Error("Normal map and albedo map are both required");
    }
    if (!this._aux) {
      if (albedo || normal) {
        throw new Error("Normal map and albedo map are not required");
      }
    }
    const width = color.width;
    const height = color.height;
    const adaptiveTileSize = this._dynamicTileController.tileSize;
    const requestedTileSize = wholeImage ? roundUp3(Math.max(width, height), OIDN_TILE_ALIGNMENT) : adaptiveTileSize;
    const defaultTileOverlap = roundUp3(this._modelSpec.receptiveField / 2, OIDN_TILE_ALIGNMENT);
    const resolvedTileOverlap = tileOverlap === void 0 ? defaultTileOverlap : roundUp3(Math.max(0, tileOverlap), OIDN_TILE_ALIGNMENT);
    const plan = planTileGrid(width, height, requestedTileSize, resolvedTileOverlap);
    const shouldAdaptTileSize = plan.tiles.length > 1;
    const hdr = this._hdr || false;
    let rawData;
    if (!isGPUImageData(color)) {
      rawData = this._processImageData(color, albedo, normal, hdr);
    }
    function makeImageData(width2, height2) {
      return hdr ? {
        data: new Float32Array(width2 * height2 * 4),
        width: width2,
        height: height2
      } : new ImageData(width2, height2);
    }
    const outputImageData = isGPUImageData(color) ? void 0 : makeImageData(width, height);
    let state = "active";
    let scheduledTimer;
    let scheduledAnimationFrame;
    let unregisterDeviceLoss = () => false;
    const now = () => typeof performance === "undefined" ? Date.now() : performance.now();
    const executionStartTime = now();
    const tileTimesMs = [];
    const profileImage = this._profileNextImage === true;
    this._profileNextImage = false;
    const layerTimes = /* @__PURE__ */ new Map();
    const cancelScheduledTile = () => {
      if (scheduledTimer !== void 0) {
        clearTimeout(scheduledTimer);
        scheduledTimer = void 0;
      }
      if (scheduledAnimationFrame !== void 0 && typeof cancelAnimationFrame !== "undefined") {
        cancelAnimationFrame(scheduledAnimationFrame);
        scheduledAnimationFrame = void 0;
      }
    };
    const reportCallbackFailure = (reason) => {
      console.error("OIDN error callback failed", reason);
    };
    const settleError = (reason) => {
      if (state !== "active")
        return;
      state = "settled";
      cancelScheduledTile();
      unregisterDeviceLoss();
      if (error) {
        try {
          void Promise.resolve(error(reason)).catch(reportCallbackFailure);
        } catch (callbackReason) {
          reportCallbackFailure(callbackReason);
        }
      } else {
        console.error("OIDN execution failed", reason);
      }
    };
    const scheduleNextTile = (callback) => {
      if (scheduling === "event-loop" || typeof requestAnimationFrame === "undefined") {
        scheduledTimer = setTimeout(() => {
          scheduledTimer = void 0;
          callback();
        }, 0);
      } else {
        const run = () => {
          cancelScheduledTile();
          callback();
        };
        scheduledAnimationFrame = requestAnimationFrame(run);
        scheduledTimer = setTimeout(run, ANIMATION_FRAME_FALLBACK_MS);
      }
    };
    const executeTile = async (tileIndex) => {
      if (state !== "active") {
        return;
      }
      const tile = plan.tiles[tileIndex];
      const outputTileData = isGPUImageData(color) ? void 0 : makeImageData(tile.output.width, tile.output.height);
      const tileStartTime = now();
      if (profileImage)
        this._nativeExecutor.profileNextExecution();
      const resGPUBuffer = await this._executeTile(isGPUImageData(color) ? {
        color: color.data,
        albedo: albedo?.data,
        normal: normal?.data
      } : rawData, outputTileData, outputImageData, tile, tileIndex === 0, width, height, hdr, denoiseAlpha);
      if (profileImage) {
        const profile = await this._nativeExecutor.getLastExecutionProfile();
        for (const layer of profile?.layers ?? []) {
          layerTimes.set(layer.id, (layerTimes.get(layer.id) ?? 0) + layer.durationMs);
        }
      }
      if (state !== "active")
        return;
      const output = outputImageData || {
        data: resGPUBuffer,
        width,
        height
      };
      if (progress) {
        await progress(
          output,
          // Is undefined if using webgpu buffer
          outputTileData,
          new Tile(tile.output.x, tile.output.y, tile.output.width, tile.output.height),
          tileIndex,
          plan.tiles.length
        );
      }
      if (state !== "active")
        return;
      const hasNextTile = tileIndex + 1 < plan.tiles.length;
      await this._device.queue.onSubmittedWorkDone();
      if (state !== "active")
        return;
      const continueAfterGPUWork = async () => {
        tileTimesMs.push(now() - tileStartTime);
        if (state !== "active")
          return;
        if (hasNextTile) {
          scheduleNextTile(() => {
            if (state !== "active")
              return;
            void executeTile(tileIndex + 1).catch(settleError);
          });
        } else {
          const sortedTileTimes = [...tileTimesMs].sort((a2, b2) => a2 - b2);
          const middle = Math.floor(sortedTileTimes.length / 2);
          const medianTileTime = sortedTileTimes.length % 2 ? sortedTileTimes[middle] : (sortedTileTimes[middle - 1] + sortedTileTimes[middle]) / 2;
          this._lastExecution = {
            width,
            height,
            tileCount: plan.tiles.length,
            tileColumns: plan.columns,
            tileRows: plan.rows,
            tileOverlap: plan.overlap,
            inputPixelCount: plan.inputPixelCount,
            inputShapeCount: plan.inputShapeCount,
            durationMs: now() - executionStartTime,
            tileTimeMs: {
              min: sortedTileTimes[0],
              median: medianTileTime,
              mean: sortedTileTimes.reduce((sum, value) => sum + value, 0) / sortedTileTimes.length,
              max: sortedTileTimes[sortedTileTimes.length - 1]
            }
          };
          if (shouldAdaptTileSize) {
            this._dynamicTileController.observe(tileTimesMs);
          }
          unregisterDeviceLoss();
          if (profileImage) {
            const layers = [...layerTimes].map(([id, durationMs]) => ({ id, durationMs }));
            this._lastImageProfile = { totalMs: layers.reduce((sum, layer) => sum + layer.durationMs, 0), layers };
          }
          await done(output);
          if (state === "active") {
            state = "settled";
          }
        }
      };
      await continueAfterGPUWork();
    };
    unregisterDeviceLoss = this._registerExecutionFailure(settleError);
    void executeTile(0).catch(settleError);
    return () => {
      if (state !== "active")
        return;
      state = "aborted";
      cancelScheduledTile();
      unregisterDeviceLoss();
    };
  }
  dispose() {
    this._dataProcessGPU?.dispose();
    this._nativeExecutor?.dispose();
    this._webNNExecutor?.dispose();
  }
};
var UNet_default = UNet;

// node_modules/oidn-webgpu/lib/backend.js
async function initWebGPUBackend() {
  if (!navigator.gpu)
    throw new Error("WebGPU is not available");
  const gpuDescriptor = {
    powerPreference: "high-performance"
  };
  const adapter = await navigator.gpu.requestAdapter(gpuDescriptor);
  if (!adapter)
    throw new Error("No WebGPU adapter is available");
  const deviceDescriptor = {};
  const requiredFeatures = [];
  if (adapter.features.has("timestamp-query")) {
    requiredFeatures.push("timestamp-query");
  }
  if (adapter.features.has("bgra8unorm-storage")) {
    requiredFeatures.push("bgra8unorm-storage");
  }
  if (adapter.features.has("shader-f16")) {
    requiredFeatures.push("shader-f16");
  }
  for (const feature of ["subgroups", "chromium-experimental-subgroup-matrix"]) {
    if (adapter.features.has(feature)) {
      requiredFeatures.push(feature);
    }
  }
  deviceDescriptor.requiredFeatures = requiredFeatures;
  const adapterLimits = adapter.limits;
  deviceDescriptor.requiredLimits = {
    maxComputeWorkgroupStorageSize: adapterLimits.maxComputeWorkgroupStorageSize,
    maxComputeWorkgroupsPerDimension: adapterLimits.maxComputeWorkgroupsPerDimension,
    maxStorageBufferBindingSize: adapterLimits.maxStorageBufferBindingSize,
    maxBufferSize: adapterLimits.maxBufferSize,
    maxComputeWorkgroupSizeX: adapterLimits.maxComputeWorkgroupSizeX,
    maxComputeInvocationsPerWorkgroup: adapterLimits.maxComputeInvocationsPerWorkgroup
  };
  return adapter.requestDevice(deviceDescriptor);
}

// node_modules/oidn-webgpu/lib/main.js
async function initUNetFromBuffer(tzaBuffer, backendParams, opts) {
  const device = backendParams?.device ?? await initWebGPUBackend();
  const tensors = parseTZA(tzaBuffer);
  const unet = new UNet_default(tensors, device, opts);
  await unet.prepare();
  return unet;
}
async function initUNetFromURL(modelPath, backendParams, opts) {
  return fetch(modelPath).then((res) => res.arrayBuffer()).then((ab) => {
    return initUNetFromBuffer(ab, backendParams, opts);
  });
}
export {
  initUNetFromURL
};
