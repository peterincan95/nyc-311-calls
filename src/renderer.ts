import { BYTES_PER_CALL, type Meta } from "./data";
import type { Selection, Slice } from "./selection";

export interface Rect {
  left: number;
  top: number;
  width: number;
  height: number;
}

interface Target {
  texture: WebGLTexture;
  framebuffer: WebGLFramebuffer;
  width: number;
  height: number;
}

type Uniforms = Record<string, WebGLUniformLocation | null>;

interface Program {
  program: WebGLProgram;
  uniforms: Uniforms;
}

interface Resources {
  points: Program;
  downsample: Program;
  blur: Program;
  composite: Program;
  pointsVao: WebGLVertexArrayObject;
  emptyVao: WebGLVertexArrayObject;
}

interface Targets {
  density: Target;
  nearA: Target;
  nearB: Target;
  farA: Target;
  farB: Target;
}

const MAX_PIXEL_RATIO = 2;
const MAP_FILL = 0.94;
const SCATTER_FILL_X = 0.96;

// Brightness of one call, reduced for large selections so dense views keep their detail.
const POINT_WEIGHT = 0.6;
const FULL_WEIGHT_CALLS = 300_000;
const WEIGHT_FALLOFF = 0.95;
const OUTSIDE_RANGE_WEIGHT = 0.16;
const NEAR_GLOW = 0.3;
const FAR_GLOW = 0.75;

const POINT_VERTEX = `#version 300 es
layout(location = 0) in vec2 a_position;
layout(location = 1) in float a_time;
uniform vec2 u_scale;
uniform vec2 u_offset;
uniform float u_timeAsY;
uniform float u_timeSpan;
uniform float u_pointSize;
void main() {
  vec2 point = vec2(a_position.x, mix(a_position.y, a_time / u_timeSpan, u_timeAsY));
  gl_Position = vec4(point * u_scale + u_offset, 0.0, 1.0);
  gl_PointSize = u_pointSize;
}`;

const POINT_FRAGMENT = `#version 300 es
precision highp float;
uniform float u_weight;
out vec4 color;
void main() { color = vec4(u_weight); }`;

const FULLSCREEN_VERTEX = `#version 300 es
out vec2 v_uv;
void main() {
  vec2 corner = vec2(float((gl_VertexID << 1) & 2), float(gl_VertexID & 2));
  v_uv = corner;
  gl_Position = vec4(corner * 2.0 - 1.0, 0.0, 1.0);
}`;

const TONE = `
float tone(float density) { return 1.0 - exp(-density); }`;

const DOWNSAMPLE_FRAGMENT = `#version 300 es
precision highp float;
in vec2 v_uv;
uniform sampler2D u_source;
uniform vec2 u_texel;
uniform float u_applyTone;
out vec4 color;
${TONE}
float read(vec2 offset) {
  float value = texture(u_source, v_uv + offset * u_texel).r;
  return mix(value, tone(value), u_applyTone);
}
void main() {
  float sum = read(vec2(-1.0, -1.0)) + read(vec2(1.0, -1.0))
            + read(vec2(-1.0, 1.0)) + read(vec2(1.0, 1.0));
  color = vec4(sum * 0.25);
}`;

const BLUR_FRAGMENT = `#version 300 es
precision highp float;
in vec2 v_uv;
uniform sampler2D u_source;
uniform vec2 u_step;
out vec4 color;
void main() {
  float sum = texture(u_source, v_uv).r * 0.1964825;
  sum += (texture(u_source, v_uv + u_step * 1.4117647).r
        + texture(u_source, v_uv - u_step * 1.4117647).r) * 0.2969069;
  sum += (texture(u_source, v_uv + u_step * 3.2941176).r
        + texture(u_source, v_uv - u_step * 3.2941176).r) * 0.0944703;
  sum += (texture(u_source, v_uv + u_step * 5.1764706).r
        + texture(u_source, v_uv - u_step * 5.1764706).r) * 0.0103814;
  color = vec4(sum);
}`;

const COMPOSITE_FRAGMENT = `#version 300 es
precision highp float;
in vec2 v_uv;
uniform sampler2D u_density;
uniform sampler2D u_near;
uniform sampler2D u_far;
uniform float u_nearGlow;
uniform float u_farGlow;
out vec4 color;
${TONE}
float noise(vec2 p) { return fract(52.9829189 * fract(dot(p, vec2(0.06711056, 0.00583715)))); }
void main() {
  float core = tone(texture(u_density, v_uv).r);
  float near = clamp(texture(u_near, v_uv).r * u_nearGlow, 0.0, 1.0);
  float far = clamp(texture(u_far, v_uv).r * u_farGlow, 0.0, 1.0);
  float light = 1.0 - (1.0 - core) * (1.0 - near) * (1.0 - far);
  light += (noise(gl_FragCoord.xy) - 0.5) / 255.0;
  color = vec4(vec3(light), 1.0);
}`;

function compile(gl: WebGL2RenderingContext, type: number, source: string): WebGLShader {
  const shader = gl.createShader(type)!;
  gl.shaderSource(shader, source);
  gl.compileShader(shader);
  if (!gl.getShaderParameter(shader, gl.COMPILE_STATUS) && !gl.isContextLost()) {
    throw new Error(`Shader failed to compile: ${gl.getShaderInfoLog(shader)}`);
  }
  return shader;
}

function createProgram(
  gl: WebGL2RenderingContext,
  vertex: string,
  fragment: string,
  uniformNames: string[],
): Program {
  const program = gl.createProgram()!;
  gl.attachShader(program, compile(gl, gl.VERTEX_SHADER, vertex));
  gl.attachShader(program, compile(gl, gl.FRAGMENT_SHADER, fragment));
  gl.linkProgram(program);
  if (!gl.getProgramParameter(program, gl.LINK_STATUS) && !gl.isContextLost()) {
    throw new Error(`Shader failed to link: ${gl.getProgramInfoLog(program)}`);
  }
  const uniforms: Uniforms = {};
  for (const name of uniformNames) uniforms[name] = gl.getUniformLocation(program, name);
  return { program, uniforms };
}

function createTarget(gl: WebGL2RenderingContext, width: number, height: number): Target {
  const texture = gl.createTexture()!;
  gl.bindTexture(gl.TEXTURE_2D, texture);
  gl.texStorage2D(gl.TEXTURE_2D, 1, gl.R16F, width, height);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);

  const framebuffer = gl.createFramebuffer()!;
  gl.bindFramebuffer(gl.FRAMEBUFFER, framebuffer);
  gl.framebufferTexture2D(gl.FRAMEBUFFER, gl.COLOR_ATTACHMENT0, gl.TEXTURE_2D, texture, 0);
  return { texture, framebuffer, width, height };
}

function deleteTarget(gl: WebGL2RenderingContext, target: Target) {
  gl.deleteTexture(target.texture);
  gl.deleteFramebuffer(target.framebuffer);
}

/**
 * Draws every call into a density buffer, then turns density into light with a
 * two-size glow. Both panels share one canvas so the data is uploaded only once.
 */
export class CallRenderer {
  private gl: WebGL2RenderingContext;
  private resources: Resources | null = null;
  private targets: Targets | null = null;
  private map: Rect | null = null;
  private scatter: Rect | null = null;
  private pixelRatio = 1;
  private selection: Selection | null = null;
  private frame = 0;

  constructor(
    private canvas: HTMLCanvasElement,
    private buffer: ArrayBuffer,
    private meta: Meta,
  ) {
    const gl = canvas.getContext("webgl2", {
      alpha: false,
      antialias: false,
      depth: false,
      powerPreference: "high-performance",
    });
    if (!gl) throw new Error("This browser doesn't support WebGL2.");
    this.gl = gl;

    canvas.addEventListener("webglcontextlost", this.onContextLost);
    canvas.addEventListener("webglcontextrestored", this.onContextRestored);
    this.createResources();
  }

  destroy() {
    cancelAnimationFrame(this.frame);
    this.canvas.removeEventListener("webglcontextlost", this.onContextLost);
    this.canvas.removeEventListener("webglcontextrestored", this.onContextRestored);
  }

  setLayout(width: number, height: number, map: Rect, scatter: Rect) {
    this.pixelRatio = Math.min(window.devicePixelRatio || 1, MAX_PIXEL_RATIO);
    this.map = map;
    this.scatter = scatter;

    const pixelWidth = Math.max(1, Math.round(width * this.pixelRatio));
    const pixelHeight = Math.max(1, Math.round(height * this.pixelRatio));
    if (this.canvas.width !== pixelWidth || this.canvas.height !== pixelHeight || !this.targets) {
      this.canvas.width = pixelWidth;
      this.canvas.height = pixelHeight;
      this.createTargets();
    }
    this.requestDraw();
  }

  setSelection(selection: Selection) {
    this.selection = selection;
    this.requestDraw();
  }

  /** Draws immediately and waits for the GPU. Returns milliseconds taken. */
  measureDraw(): number {
    const pixel = new Uint8Array(4);
    const started = performance.now();
    this.draw();
    this.gl.readPixels(0, 0, 1, 1, this.gl.RGBA, this.gl.UNSIGNED_BYTE, pixel);
    return performance.now() - started;
  }

  private onContextLost = (event: Event) => {
    event.preventDefault();
    cancelAnimationFrame(this.frame);
    this.frame = 0;
    this.resources = null;
    this.targets = null;
  };

  private onContextRestored = () => {
    this.createResources();
    this.createTargets();
    this.requestDraw();
  };

  private createResources() {
    const { gl } = this;
    if (!gl.getExtension("EXT_color_buffer_float")) {
      throw new Error("This graphics card doesn't support the float rendering this app needs.");
    }

    const pointsVao = gl.createVertexArray()!;
    gl.bindVertexArray(pointsVao);
    gl.bindBuffer(gl.ARRAY_BUFFER, gl.createBuffer());
    gl.bufferData(gl.ARRAY_BUFFER, this.buffer, gl.STATIC_DRAW);
    gl.enableVertexAttribArray(0);
    gl.vertexAttribPointer(0, 2, gl.UNSIGNED_SHORT, true, BYTES_PER_CALL, 0);
    gl.enableVertexAttribArray(1);
    gl.vertexAttribPointer(1, 1, gl.UNSIGNED_INT, false, BYTES_PER_CALL, 4);

    this.resources = {
      points: createProgram(gl, POINT_VERTEX, POINT_FRAGMENT, [
        "u_scale",
        "u_offset",
        "u_timeAsY",
        "u_timeSpan",
        "u_pointSize",
        "u_weight",
      ]),
      downsample: createProgram(gl, FULLSCREEN_VERTEX, DOWNSAMPLE_FRAGMENT, [
        "u_source",
        "u_texel",
        "u_applyTone",
      ]),
      blur: createProgram(gl, FULLSCREEN_VERTEX, BLUR_FRAGMENT, ["u_source", "u_step"]),
      composite: createProgram(gl, FULLSCREEN_VERTEX, COMPOSITE_FRAGMENT, [
        "u_density",
        "u_near",
        "u_far",
        "u_nearGlow",
        "u_farGlow",
      ]),
      pointsVao,
      emptyVao: gl.createVertexArray()!,
    };
  }

  private createTargets() {
    const { gl, canvas } = this;
    if (this.targets) {
      for (const target of Object.values(this.targets)) deleteTarget(gl, target);
    }
    const size = (divisor: number) =>
      [
        Math.max(1, Math.ceil(canvas.width / divisor)),
        Math.max(1, Math.ceil(canvas.height / divisor)),
      ] as const;
    this.targets = {
      density: createTarget(gl, canvas.width, canvas.height),
      nearA: createTarget(gl, ...size(4)),
      nearB: createTarget(gl, ...size(4)),
      farA: createTarget(gl, ...size(16)),
      farB: createTarget(gl, ...size(16)),
    };
  }

  private requestDraw() {
    if (this.frame) return;
    this.frame = requestAnimationFrame(() => {
      this.frame = 0;
      this.draw();
    });
  }

  private draw() {
    const { gl, resources, targets, map, scatter, selection } = this;
    if (!resources || !targets || !map || !scatter || !selection) return;

    gl.bindFramebuffer(gl.FRAMEBUFFER, targets.density.framebuffer);
    gl.disable(gl.SCISSOR_TEST);
    gl.viewport(0, 0, targets.density.width, targets.density.height);
    gl.clearColor(0, 0, 0, 0);
    gl.clear(gl.COLOR_BUFFER_BIT);

    const { points, pointsVao } = resources;
    gl.useProgram(points.program);
    gl.bindVertexArray(pointsVao);
    gl.enable(gl.BLEND);
    gl.blendFunc(gl.ONE, gl.ONE);
    gl.enable(gl.SCISSOR_TEST);
    gl.uniform1f(points.uniforms.u_timeSpan!, this.meta.tEnd - this.meta.tStart);
    gl.uniform1f(points.uniforms.u_pointSize!, Math.max(1, Math.round(this.pixelRatio)));

    const weight =
      POINT_WEIGHT *
      Math.min(1, (FULL_WEIGHT_CALLS / Math.max(1, selection.totalCount)) ** WEIGHT_FALLOFF);

    this.setPanel(map);
    this.setProjection(this.mapFill(map), 0);
    this.drawSlices(selection.inside, weight);

    this.setPanel(scatter);
    // A negative fill runs time downward, with the oldest calls at the top.
    this.setProjection([SCATTER_FILL_X, -1], 1);
    this.drawSlices(selection.inside, weight);
    this.drawSlices(selection.outside, weight * OUTSIDE_RANGE_WEIGHT);

    gl.disable(gl.BLEND);
    gl.disable(gl.SCISSOR_TEST);
    this.drawGlow(resources, targets);
  }

  private setPanel(rect: Rect) {
    const { gl, canvas, pixelRatio } = this;
    const x = Math.round(rect.left * pixelRatio);
    const y = canvas.height - Math.round((rect.top + rect.height) * pixelRatio);
    const width = Math.round(rect.width * pixelRatio);
    const height = Math.round(rect.height * pixelRatio);
    gl.viewport(x, y, width, height);
    gl.scissor(x, y, width, height);
  }

  /** The share of the map panel the city fills, keeping it undistorted. */
  private mapFill(rect: Rect): [number, number] {
    const { lonMin, lonMax, latMin, latMax } = this.meta.bounds;
    const middleLatitude = ((latMin + latMax) / 2) * (Math.PI / 180);
    const cityAspect = ((lonMax - lonMin) * Math.cos(middleLatitude)) / (latMax - latMin);
    const panelAspect = rect.width / rect.height;
    return panelAspect > cityAspect
      ? [(MAP_FILL * cityAspect) / panelAspect, MAP_FILL]
      : [MAP_FILL, (MAP_FILL * panelAspect) / cityAspect];
  }

  private setProjection([fillX, fillY]: [number, number] | number[], timeAsY: number) {
    const { gl } = this;
    const { uniforms } = this.resources!.points;
    gl.uniform2f(uniforms.u_scale!, 2 * fillX!, 2 * fillY!);
    gl.uniform2f(uniforms.u_offset!, -fillX!, -fillY!);
    gl.uniform1f(uniforms.u_timeAsY!, timeAsY);
  }

  private drawSlices(slices: Slice[], weight: number) {
    const { gl } = this;
    gl.uniform1f(this.resources!.points.uniforms.u_weight!, weight);
    for (const { first, count } of slices) gl.drawArrays(gl.POINTS, first, count);
  }

  private drawGlow(resources: Resources, targets: Targets) {
    const { gl } = this;
    const { downsample, blur, composite, emptyVao } = resources;
    gl.bindVertexArray(emptyVao);
    gl.activeTexture(gl.TEXTURE0);

    const pass = (target: Target | null) => {
      gl.bindFramebuffer(gl.FRAMEBUFFER, target?.framebuffer ?? null);
      gl.viewport(0, 0, target?.width ?? this.canvas.width, target?.height ?? this.canvas.height);
      gl.drawArrays(gl.TRIANGLES, 0, 3);
    };
    const shrink = (source: Target, target: Target, applyTone: number) => {
      gl.useProgram(downsample.program);
      gl.bindTexture(gl.TEXTURE_2D, source.texture);
      gl.uniform1i(downsample.uniforms.u_source!, 0);
      gl.uniform2f(downsample.uniforms.u_texel!, 1 / source.width, 1 / source.height);
      gl.uniform1f(downsample.uniforms.u_applyTone!, applyTone);
      pass(target);
    };
    const soften = (main: Target, spare: Target) => {
      gl.useProgram(blur.program);
      gl.uniform1i(blur.uniforms.u_source!, 0);
      gl.bindTexture(gl.TEXTURE_2D, main.texture);
      gl.uniform2f(blur.uniforms.u_step!, 1 / main.width, 0);
      pass(spare);
      gl.bindTexture(gl.TEXTURE_2D, spare.texture);
      gl.uniform2f(blur.uniforms.u_step!, 0, 1 / main.height);
      pass(main);
    };

    shrink(targets.density, targets.nearA, 1);
    shrink(targets.nearA, targets.farA, 0);
    soften(targets.nearA, targets.nearB);
    soften(targets.farA, targets.farB);

    gl.useProgram(composite.program);
    gl.activeTexture(gl.TEXTURE0);
    gl.bindTexture(gl.TEXTURE_2D, targets.density.texture);
    gl.activeTexture(gl.TEXTURE1);
    gl.bindTexture(gl.TEXTURE_2D, targets.nearA.texture);
    gl.activeTexture(gl.TEXTURE2);
    gl.bindTexture(gl.TEXTURE_2D, targets.farA.texture);
    gl.uniform1i(composite.uniforms.u_density!, 0);
    gl.uniform1i(composite.uniforms.u_near!, 1);
    gl.uniform1i(composite.uniforms.u_far!, 2);
    gl.uniform1f(composite.uniforms.u_nearGlow!, NEAR_GLOW);
    gl.uniform1f(composite.uniforms.u_farGlow!, FAR_GLOW);
    pass(null);
    gl.activeTexture(gl.TEXTURE0);
  }
}
