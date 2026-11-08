import { BOROUGH_SHIFT, BYTES_PER_CALL, type CallData, type Meta } from "./data";
import { GRID_MAX, SECONDS_PER_DAY, winterTime, type Selection, type Slice } from "./selection";

/** The map's view: `x` and `y` are the share of the city at the panel's center. */
export interface Camera {
  zoom: number;
  x: number;
  y: number;
}

/** What the scatterplot's x-axis shows. */
export type ScatterAxis = "longitude" | "time";

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

// Point colors from no calls to the densest areas, evenly spaced. Add or remove
// stops freely, but keep the first one black so empty areas match the background.
export const COLOR_STOPS = ["#000000", "#893426", "#E67F0E", "#FABA58", "#FFF3DA"];

const MAX_PIXEL_RATIO = 2;
const MAP_FILL = 0.94;
export const SCATTER_FILL_X = 0.96;

// Width of a point in CSS pixels, rounded to whole device pixels when drawn.
const POINT_SIZE = 1.7;
// The closest the map and scatterplot zoom in.
export const MAX_ZOOM = 18;
// Points grow with zoom, reaching this multiple of their size at MAX_ZOOM.
const MAX_ZOOM_GROWTH = 3.46;
const ZOOM_GROWTH_POWER = Math.log(MAX_ZOOM_GROWTH) / Math.log(MAX_ZOOM);
// Points on the zoomed-out map are this many device pixels smaller, reaching full size
// by MAP_FULL_SIZE_ZOOM. Sizes round to whole device pixels, so a share of the size
// would vanish on some screens.
const MAP_HOME_SHRINK_PIXELS = 1;
const MAP_FULL_SIZE_ZOOM = 2;
// Added to a point's brightness for each doubling of zoom. The scatterplot has no
// empty streets or parks to set points off, so a lot of brightness washes it out.
const MAP_ZOOM_BRIGHTNESS = 0.9;
const SCATTER_ZOOM_BRIGHTNESS = 0;
// Points this many device pixels wide or more are drawn round.
const ROUND_POINT_SIZE = 4;

// Brightness of one call. It falls once points would cover a plot more than this
// many times over, so dense views keep their detail and look alike at any size.
const POINT_WEIGHT = 0.3;
const FULL_WEIGHT_COVERAGE = 0.6;
const WEIGHT_FALLOFF = 0.95;
const OUTSIDE_RANGE_WEIGHT = 0.16;
// Share of their color the scatterplot's calls outside the date range lose.
const OUTSIDE_RANGE_DESATURATION = 0.5;
// A call's time of day is only exact to two seconds on the GPU.
const TIME_MARGIN_SECONDS = 2;
const NEAR_GLOW = 0.3;
const FAR_GLOW = 0.75;

// The opacity slider scales brightness by up to this factor either way from its middle.
const MAX_OPACITY_SCALE = 8;
// Coloring by borough turns each borough's colors this far around the color wheel, by
// borough id. Unknown boroughs keep the usual colors.
const BOROUGH_HUE_DEGREES = [0, 28, 72, 144, 216, 288, 0, 0];

/** How points are drawn, from the visualization options. */
export interface PointStyle {
  /** 0 to 100, where 50 leaves the brightness the app picks. */
  opacity: number;
  colorByBorough: boolean;
}

const POINT_VERTEX = `#version 300 es
layout(location = 0) in vec2 a_position;
layout(location = 1) in float a_time;
layout(location = 2) in uint a_tags;
uniform vec2 u_scale;
uniform vec2 u_offset;
uniform float u_timeAsX;
uniform float u_timeAsY;
uniform float u_timeSpan;
uniform vec2 u_winterTime;
uniform vec2 u_timeRange;
uniform float u_pointSize;
uniform uint u_tagMask;
uniform uint u_tagMatch;
uniform vec4 u_area;
uniform vec2 u_boroughHues[8];
flat out vec2 v_hue;
void main() {
  gl_PointSize = u_pointSize;
  v_hue = u_boroughHues[(a_tags >> ${BOROUGH_SHIFT}u) & 7u];
  bool isWinter = a_time >= u_winterTime.x && a_time < u_winterTime.y;
  float second = mod(a_time - (isWinter ? 3600.0 : 0.0), ${SECONDS_PER_DAY}.0);
  bool outsideArea = any(lessThan(a_position, u_area.xy)) || any(greaterThan(a_position, u_area.zw))
    || second < u_timeRange.x || second > u_timeRange.y;
  if ((a_tags & u_tagMask) != u_tagMatch || outsideArea) {
    // Outside the clip volume, so the point is never drawn.
    gl_Position = vec4(2.0, 2.0, 0.0, 1.0);
    return;
  }
  vec2 point = vec2(
    mix(a_position.x, second / ${SECONDS_PER_DAY}.0, u_timeAsX),
    mix(a_position.y, a_time / u_timeSpan, u_timeAsY)
  );
  gl_Position = vec4(point * u_scale + u_offset, 0.0, 1.0);
}`;

const POINT_FRAGMENT = `#version 300 es
precision highp float;
uniform float u_weight;
uniform float u_pointSize;
uniform float u_roundSize;
uniform float u_isOutside;
flat in vec2 v_hue;
out vec4 color;
void main() {
  float coverage = 1.0;
  if (u_pointSize >= u_roundSize) {
    float distance = length(gl_PointCoord - 0.5) * 2.0;
    coverage = 1.0 - smoothstep(1.0 - 2.0 / u_pointSize, 1.0, distance);
  }
  // Density in red, each point's borough hue as a direction in green and blue, and the
  // density of calls outside the date range in alpha.
  float weight = u_weight * coverage;
  color = vec4(weight, weight * v_hue, weight * u_isOutside);
}`;

const FULLSCREEN_VERTEX = `#version 300 es
out vec2 v_uv;
void main() {
  vec2 corner = vec2(float((gl_VertexID << 1) & 2), float(gl_VertexID & 2));
  v_uv = corner;
  gl_Position = vec4(corner * 2.0 - 1.0, 0.0, 1.0);
}`;

const TONE = `
float tone(float density) { return 1.0 - exp(-density); }
// Tones the density and scales the other channels to match.
vec4 toned(vec4 value) {
  float light = tone(value.r);
  return vec4(light, value.gba * (light / max(value.r, 1e-6)));
}`;

const DOWNSAMPLE_FRAGMENT = `#version 300 es
precision highp float;
in vec2 v_uv;
uniform sampler2D u_source;
uniform vec2 u_texel;
uniform float u_applyTone;
out vec4 color;
${TONE}
vec4 read(vec2 offset) {
  vec4 value = texture(u_source, v_uv + offset * u_texel);
  return mix(value, toned(value), u_applyTone);
}
void main() {
  vec4 sum = read(vec2(-1.0, -1.0)) + read(vec2(1.0, -1.0))
           + read(vec2(-1.0, 1.0)) + read(vec2(1.0, 1.0));
  color = sum * 0.25;
}`;

const BLUR_FRAGMENT = `#version 300 es
precision highp float;
in vec2 v_uv;
uniform sampler2D u_source;
uniform vec2 u_step;
out vec4 color;
void main() {
  vec4 sum = texture(u_source, v_uv) * 0.1964825;
  sum += (texture(u_source, v_uv + u_step * 1.4117647)
        + texture(u_source, v_uv - u_step * 1.4117647)) * 0.2969069;
  sum += (texture(u_source, v_uv + u_step * 3.2941176)
        + texture(u_source, v_uv - u_step * 3.2941176)) * 0.0944703;
  sum += (texture(u_source, v_uv + u_step * 5.1764706)
        + texture(u_source, v_uv - u_step * 5.1764706)) * 0.0103814;
  color = sum;
}`;

function hexToVec3(hex: string) {
  const channels = [1, 3, 5].map((start) => parseInt(hex.slice(start, start + 2), 16) / 255);
  return `vec3(${channels.map((channel) => channel.toFixed(4)).join(", ")})`;
}

const COMPOSITE_FRAGMENT = `#version 300 es
precision highp float;
in vec2 v_uv;
uniform sampler2D u_density;
uniform sampler2D u_near;
uniform sampler2D u_far;
uniform float u_nearGlow;
uniform float u_farGlow;
uniform float u_colorByBorough;
uniform float u_outsideDesaturation;
out vec4 color;
${TONE}
const int STOP_COUNT = ${COLOR_STOPS.length};
const vec3 STOPS[STOP_COUNT] = vec3[STOP_COUNT](${COLOR_STOPS.map(hexToVec3).join(", ")});
vec3 gradient(float value) {
  float position = clamp(value, 0.0, 1.0) * float(STOP_COUNT - 1);
  int stop = min(int(position), STOP_COUNT - 2);
  return mix(STOPS[stop], STOPS[stop + 1], position - float(stop));
}
float noise(vec2 p) { return fract(52.9829189 * fract(dot(p, vec2(0.06711056, 0.00583715)))); }
// The same turn around the color wheel as CSS hue-rotate().
vec3 hueRotate(vec3 c, float angle) {
  float k = cos(angle);
  float s = sin(angle);
  mat3 turn = mat3(
    0.213 + k * 0.787 - s * 0.213, 0.213 - k * 0.213 + s * 0.143, 0.213 - k * 0.213 - s * 0.787,
    0.715 - k * 0.715 - s * 0.715, 0.715 + k * 0.285 + s * 0.140, 0.715 - k * 0.715 + s * 0.715,
    0.072 - k * 0.072 + s * 0.928, 0.072 - k * 0.072 - s * 0.283, 0.072 + k * 0.928 + s * 0.072);
  return clamp(turn * c, 0.0, 1.0);
}
void main() {
  vec4 core = toned(texture(u_density, v_uv));
  vec4 near = texture(u_near, v_uv) * u_nearGlow;
  vec4 far = texture(u_far, v_uv) * u_farGlow;
  float nearLight = clamp(near.r, 0.0, 1.0);
  float farLight = clamp(far.r, 0.0, 1.0);
  float light = 1.0 - (1.0 - core.r) * (1.0 - nearLight) * (1.0 - farLight);
  light += (noise(gl_FragCoord.xy) - 0.5) / 255.0;
  vec3 rgb = gradient(light);
  // Where boroughs meet, their hue directions blend.
  vec2 hue = core.gb + near.gb + far.gb;
  if (u_colorByBorough > 0.5 && length(hue) > 1e-5) rgb = hueRotate(rgb, atan(hue.y, hue.x));
  // Grays by the share of the light that comes from calls outside the date range.
  float outside = (core.a + near.a + far.a) / max(core.r + near.r + far.r, 1e-6);
  float gray = dot(rgb, vec3(0.2126, 0.7152, 0.0722));
  rgb = mix(rgb, vec3(gray), clamp(outside, 0.0, 1.0) * u_outsideDesaturation);
  color = vec4(rgb, 1.0);
}`;

/** The share of the map panel's width and height the city fills, keeping it undistorted. */
export function mapFill(
  { lonMin, lonMax, latMin, latMax }: Meta["bounds"],
  width: number,
  height: number,
): [number, number] {
  const middleLatitude = ((latMin + latMax) / 2) * (Math.PI / 180);
  const cityAspect = ((lonMax - lonMin) * Math.cos(middleLatitude)) / (latMax - latMin);
  const panelAspect = width / height;
  return panelAspect > cityAspect
    ? [(MAP_FILL * cityAspect) / panelAspect, MAP_FILL]
    : [MAP_FILL, (MAP_FILL * panelAspect) / cityAspect];
}

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
  gl.texStorage2D(gl.TEXTURE_2D, 1, gl.RGBA16F, width, height);
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
  private camera: Camera = { zoom: 1, x: 0.5, y: 0.5 };
  private frame = 0;
  private scatterCamera: Camera = { zoom: 1, x: 0.5, y: 0.5 };
  private needsMapDraw = true;
  private needsScatterDraw = true;
  private scatterAxis: ScatterAxis = "longitude";
  private opacityScale = 1;
  private colorByBorough = false;

  constructor(
    private canvas: HTMLCanvasElement,
    private data: CallData,
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

  setScatterAxis(axis: ScatterAxis) {
    this.scatterAxis = axis;
    this.requestDraw();
  }

  setPointStyle({ opacity, colorByBorough }: PointStyle) {
    this.opacityScale = MAX_OPACITY_SCALE ** ((opacity - 50) / 50);
    this.colorByBorough = colorByBorough;
    this.requestDraw();
  }

  /** Only the map changes, so the scatterplot can keep what it last drew. */
  setCamera(camera: Camera) {
    this.camera = camera;
    this.requestDraw(true, false);
  }

  /** Only the scatterplot changes, so the map can keep what it last drew. */
  setScatterCamera(camera: Camera) {
    this.scatterCamera = camera;
    this.requestDraw(false, true);
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
    gl.bufferData(gl.ARRAY_BUFFER, new Uint8Array(this.data.buffer), gl.STATIC_DRAW);
    gl.enableVertexAttribArray(0);
    gl.vertexAttribPointer(0, 2, gl.UNSIGNED_SHORT, true, BYTES_PER_CALL, 0);
    gl.enableVertexAttribArray(1);
    gl.vertexAttribPointer(1, 1, gl.UNSIGNED_INT, false, BYTES_PER_CALL, 4);
    gl.bindBuffer(gl.ARRAY_BUFFER, gl.createBuffer());
    gl.bufferData(gl.ARRAY_BUFFER, this.data.tags, gl.STATIC_DRAW);
    gl.enableVertexAttribArray(2);
    gl.vertexAttribIPointer(2, 1, gl.UNSIGNED_INT, 0, 0);

    this.resources = {
      points: createProgram(gl, POINT_VERTEX, POINT_FRAGMENT, [
        "u_scale",
        "u_offset",
        "u_timeAsX",
        "u_timeAsY",
        "u_winterTime",
        "u_timeRange",
        "u_timeSpan",
        "u_pointSize",
        "u_weight",
        "u_tagMask",
        "u_tagMatch",
        "u_area",
        "u_roundSize",
        "u_boroughHues",
        "u_isOutside",
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
        "u_colorByBorough",
        "u_outsideDesaturation",
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

  private requestDraw(needsMap = true, needsScatter = true) {
    this.needsMapDraw ||= needsMap;
    this.needsScatterDraw ||= needsScatter;
    if (this.frame) return;
    this.frame = requestAnimationFrame(() => {
      this.frame = 0;
      this.draw(this.needsMapDraw, this.needsScatterDraw);
    });
  }

  private draw(drawMap = true, drawScatter = true) {
    const { gl, resources, targets, map, scatter, selection } = this;
    if (!resources || !targets || !map || !scatter || !selection) return;
    this.needsMapDraw = false;
    this.needsScatterDraw = false;

    gl.bindFramebuffer(gl.FRAMEBUFFER, targets.density.framebuffer);
    gl.clearColor(0, 0, 0, 0);

    const { points, pointsVao } = resources;
    gl.useProgram(points.program);
    gl.bindVertexArray(pointsVao);
    gl.enable(gl.BLEND);
    gl.blendFunc(gl.ONE, gl.ONE);
    gl.enable(gl.SCISSOR_TEST);
    const { meta } = this.data;
    gl.uniform1f(points.uniforms.u_timeSpan!, meta.tEnd - meta.tStart);
    gl.uniform2f(points.uniforms.u_winterTime!, ...winterTime(meta));
    gl.uniform1ui(points.uniforms.u_tagMask!, selection.mask);
    gl.uniform1ui(points.uniforms.u_tagMatch!, selection.match);
    // Half a grid step past each edge, so rounding can't drop calls on the edge.
    const { west, east, south, north, timeFrom, timeTo } = selection.area;
    gl.uniform4f(
      points.uniforms.u_area!,
      (west - 0.5) / GRID_MAX,
      (south - 0.5) / GRID_MAX,
      (east + 0.5) / GRID_MAX,
      (north + 0.5) / GRID_MAX,
    );
    gl.uniform2f(
      points.uniforms.u_timeRange!,
      timeFrom - TIME_MARGIN_SECONDS,
      timeTo + TIME_MARGIN_SECONDS,
    );
    gl.uniform1f(points.uniforms.u_roundSize!, ROUND_POINT_SIZE);
    gl.uniform2fv(
      points.uniforms.u_boroughHues!,
      BOROUGH_HUE_DEGREES.flatMap((degrees) => {
        const radians = (degrees * Math.PI) / 180;
        return [Math.cos(radians), Math.sin(radians)];
      }),
    );

    if (drawMap) {
      const { zoom, x, y } = this.camera;
      const fill = mapFill(this.data.meta.bounds, map.width, map.height);
      const filled = fill[0] * fill[1];
      const toFullSize = Math.min(1, Math.log2(zoom) / Math.log2(MAP_FULL_SIZE_ZOOM));
      const shrink = MAP_HOME_SHRINK_PIXELS * (1 - toFullSize);
      const weight = this.startPanel(
        selection,
        map,
        filled,
        zoom,
        MAP_ZOOM_BRIGHTNESS,
        shrink,
      );
      const scaleX = 2 * fill[0] * zoom;
      const scaleY = 2 * fill[1] * zoom;
      this.setProjection(scaleX, scaleY, -scaleX * x, -scaleY * y, 0, 0);
      this.drawSlices(selection.inside, weight);
    }

    if (drawScatter) {
      const { zoom, x, y } = this.scatterCamera;
      const weight = this.startPanel(
        selection,
        scatter,
        SCATTER_FILL_X,
        zoom,
        SCATTER_ZOOM_BRIGHTNESS,
      );
      const timeAsX = this.scatterAxis === "time" ? 1 : 0;
      const scaleX = 2 * SCATTER_FILL_X * zoom;
      // A negative scale runs time downward, with the oldest calls at the top.
      const scaleY = -2 * zoom;
      this.setProjection(scaleX, scaleY, -scaleX * x, -scaleY * y, timeAsX, 1);
      this.drawSlices(selection.inside, weight);
      this.drawSlices(selection.outside, weight * OUTSIDE_RANGE_WEIGHT, true);
    }

    gl.disable(gl.BLEND);
    gl.disable(gl.SCISSOR_TEST);
    this.drawGlow(resources, targets);
  }

  /** Clears a panel and sizes its points for the zoom. Returns the points' brightness. */
  private startPanel(
    selection: Selection,
    rect: Rect,
    filled: number,
    zoom: number,
    zoomBrightness: number,
    shrinkPixels = 0,
  ) {
    const { gl } = this;
    const growth = Math.min(zoom ** ZOOM_GROWTH_POWER, MAX_ZOOM_GROWTH);
    const pointSize = this.devicePointSize(growth, shrinkPixels);
    const baseWeight = this.pointWeight(selection, pointSize, rect, filled * zoom ** 2);
    // Crowded views get less of the boost, so dense blocks don't merge into a haze.
    const roominess = Math.sqrt(baseWeight / POINT_WEIGHT);

    this.setPanel(rect);
    gl.clear(gl.COLOR_BUFFER_BIT);
    gl.uniform1f(this.resources!.points.uniforms.u_pointSize!, pointSize);
    const weight = baseWeight * (1 + zoomBrightness * Math.log2(zoom) * roominess);
    return weight * this.opacityScale;
  }

  private devicePointSize(growth: number, shrinkPixels = 0) {
    return Math.max(1, Math.round(POINT_SIZE * growth * this.pixelRatio - shrinkPixels));
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

  /** Uses the whole year's calls, so brightness holds steady while the range is dragged. */
  private pointWeight(selection: Selection, pointSize: number, rect: Rect, filled: number) {
    const plotPixels = rect.width * rect.height * this.pixelRatio ** 2 * filled;
    const coverage = (selection.cityCount * pointSize ** 2) / plotPixels;
    return POINT_WEIGHT * Math.min(1, (FULL_WEIGHT_COVERAGE / coverage) ** WEIGHT_FALLOFF);
  }

  private setProjection(
    scaleX: number,
    scaleY: number,
    offsetX: number,
    offsetY: number,
    timeAsX: number,
    timeAsY: number,
  ) {
    const { gl } = this;
    const { uniforms } = this.resources!.points;
    gl.uniform2f(uniforms.u_scale!, scaleX, scaleY);
    gl.uniform2f(uniforms.u_offset!, offsetX, offsetY);
    gl.uniform1f(uniforms.u_timeAsX!, timeAsX);
    gl.uniform1f(uniforms.u_timeAsY!, timeAsY);
  }

  private drawSlices(slices: Slice[], weight: number, isOutside = false) {
    const { gl } = this;
    const { uniforms } = this.resources!.points;
    gl.uniform1f(uniforms.u_weight!, weight);
    gl.uniform1f(uniforms.u_isOutside!, isOutside ? 1 : 0);
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
    gl.uniform1f(composite.uniforms.u_colorByBorough!, this.colorByBorough ? 1 : 0);
    gl.uniform1f(composite.uniforms.u_outsideDesaturation!, OUTSIDE_RANGE_DESATURATION);
    pass(null);
    gl.activeTexture(gl.TEXTURE0);
  }
}
