import { useEffect, useRef } from 'react'
import { useSettingsStore } from '../../../store/settings.store'
import { useUIStore } from '../../../store/ui.store'
import {
  subscribeAudioVisualizer,
  normalizeVisualizerPreset,
  type AudioFrame,
  type AudioVisualizerPreset
} from '../../../utils/systemAudioVisualizer'

// ── Шейдерный аудио-визуализатор вокруг поля ввода (WebGL2) ───────────────
// Все эффекты — фрагментные шейдеры в духе анимированного фона (bg.worker.ts).
// Настроек яркости/чувствительности нет: у каждого пресета зашита идеальная
// подстройка (EFFECT_TUNING). 64 полосы спектра, гамма-буст, бит-детект.
//
// Пресеты:
//   fire     — огонь над рамкой + тёплая «переливашка» под баром
//   sparks   — искры-угольки взлетают над рамкой, гейт от громкости
//   wave     — одна плавная живая кривая спектра, прижатая к инпуту
//   spectrum — 48 палочек спектра растут наружу от рамки по всему периметру
//              (равномерная разметка периметра — без растяжения по углам)
//
// Все эффекты рисуются ВНЕ рамки инпута (SDF-маска u_box) — текст не
// перекрывается. В тишине всё гаснет полностью (soundGate по u_level).

const VERT_SRC = `#version 300 es
layout(location=0) in vec2 aPos;
void main(){ gl_Position = vec4(aPos, 0.0, 1.0); }`

const COMMON = `#version 300 es
precision highp float;
out vec4 fragColor;
uniform vec2  u_res;        // размер канваса (device px)
uniform float u_time;       // секунды
uniform float u_level;      // общая громкость 0..1 (сглажено)
uniform float u_bass;       // 0..1
uniform float u_mid;        // 0..1
uniform float u_treble;     // 0..1
uniform float u_beat;       // 0..1, вспышка на бит
uniform float u_intensity;  // идеальная интенсивность пресета
uniform vec3  u_color;      // основной цвет (accent/custom)
uniform vec3  u_color2;     // второй цвет градиента
uniform int   u_colorMode;  // 0 accent, 1 custom, 2 gradient, 3 rainbow
uniform float u_bands[64];  // спектр 0..1
uniform vec4  u_box;        // (cx, cy, hx, hy) инпут-бокса, device px, y вверх
uniform float u_seed;
uniform float u_dpr;        // device pixel ratio (для CSS-px размеров палочек)

float hash11(float p){ p = fract(p*443.8975); p += dot(p, p+19.19); return fract(p*0.6019); }
float hash21(vec2 p){ return hash11(p.x + p.y*127.1); }
float vnoise(vec2 p){
  vec2 i = floor(p), f = fract(p);
  vec2 u = f*f*(3.0-2.0*f);
  float a = hash21(i);
  float b = hash21(i+vec2(1.0,0.0));
  float c = hash21(i+vec2(0.0,1.0));
  float d = hash21(i+vec2(1.0,1.0));
  return mix(mix(a,b,u.x), mix(c,d,u.x), u.y);
}
float fbm(vec2 p){
  float v = 0.0, a = 0.5;
  for(int i=0;i<5;i++){ v += a*vnoise(p); p *= 2.03; a *= 0.5; }
  return v;
}
float fbm3(vec2 p){
  float v = 0.0, a = 0.5;
  for(int i=0;i<3;i++){ v += a*vnoise(p); p *= 2.03; a *= 0.5; }
  return v;
}

// линейная выборка спектра по x 0..1
float sampleBand(float x){
  float f = clamp(x, 0.0, 1.0) * 63.0;
  float i = floor(f);
  float fr = f - i;
  int a = int(i);
  int b = min(a + 1, 63);
  return mix(u_bands[a], u_bands[b], fr);
}

vec3 hue2rgb(float h){
  vec3 k = mod(vec3(5.0, 3.0, 1.0) + h * 6.0, 6.0);
  return clamp(abs(k - 3.0) - 1.0, 0.0, 1.0);
}

// цвет эффекта по режиму; t — позиционный параметр 0..1
vec3 baseColor(float t){
  if (u_colorMode == 3) return mix(vec3(0.6), hue2rgb(fract(t + u_time * 0.04)), 0.9);
  if (u_colorMode == 2) return mix(u_color, u_color2, clamp(t, 0.0, 1.0));
  return u_color;
}

// signed distance до прямоугольника инпута (0 на границе, <0 внутри)
float sdBox(vec2 p){
  vec2 d = abs(p - u_box.xy) - u_box.zw;
  return length(max(d, vec2(0.0))) + min(max(d.x, d.y), 0.0);
}

// полное затухание в тишине: без звука эффекты исчезают
float soundGate(){ return smoothstep(0.015, 0.1, u_level); }
`

// ── FIRE: огонь над рамкой + тёплая переливашка под баром ────────────────
const FIRE_FRAG = COMMON + `
void main(){
  vec2 uv = gl_FragCoord.xy / u_res;
  vec2 p = gl_FragCoord.xy;
  float sd = sdBox(p);
  float boxBottom = u_box.y - u_box.w;
  float below = boxBottom - p.y; // >0 ниже нижней грани инпута
  // ОПТИМИЗАЦИЯ: sd < -1 — интерьер рамки. Огонь там математически нулевой
  // (множитель smoothstep(-1,3,sd)=0 => f=0 => ранний выход уже был), а
  // переливашка ниже грани имеет sd > 0. Пропускаем два fbm (~32 hash) для
  // ~40% пикселей канваса — вывод побитово тот же.
  if (sd < -1.0) { fragColor = vec4(0.0); return; }
  float t = u_time * (1.0 + u_bass * 0.9 + u_level * 0.4) + u_seed * 7.0;
  float ef = smoothstep(0.0, 0.05, uv.x) * smoothstep(1.0, 0.95, uv.x);

  // ── под баром: не огонь, а переливашка — мягкое течение, дышит звуком,
  //    тёплым цветом сливается с пламенем над рамкой ──
  if (below > 0.25) {
    float flow = fbm(vec2(uv.x * 5.0 - t * 0.8, below * 0.3 + u_seed));
    float glowB = exp(-below * 0.45) * (0.12 + u_bass * 0.5 + u_level * 0.3 + u_beat * 0.18);
    vec3 warm = vec3(1.0, 0.55, 0.2);
    vec3 colB = mix(warm, baseColor(fract(uv.x * 0.7 + flow * 0.4 + u_time * 0.05)), 0.45);
    colB *= (0.55 + flow * 0.7);
    float alphaB = clamp(glowB * u_intensity, 0.0, 0.7) * soundGate() * ef;
    fragColor = vec4(colB * alphaB, alphaB);
    return;
  }

  // ── над рамкой и по бокам: огонь ──
  // симметричный спектр: центр = бас, края = верха — обе стороны живые
  float bx = abs(uv.x - 0.5) * 2.0;
  float band = sampleBand(bx);
  float hPx = (0.12 + band * 0.6 + u_bass * 0.28 + u_beat * 0.15) * 56.0;

  // шум: поле скроллится вниз => языки поднимаются
  vec2 np = vec2(uv.x * 7.0 + u_seed, uv.y * 2.4 - t * 2.4);
  float n = fbm(np);
  float n2 = fbm3(np * 2.4 + vec2(t * 0.3, t * 1.2));

  // пламя только снаружи рамки и не ниже нижней грани (там переливашка)
  float f = (hPx - sd + (n - 0.5) * 24.0 + (n2 - 0.5) * 9.0) / 24.0;
  f = clamp(f, 0.0, 1.0) * smoothstep(-1.0, 3.0, sd) * smoothstep(-1.0, 1.0, p.y - boxBottom);
  f *= ef * smoothstep(1.0, 0.9, uv.y);
  if (f <= 0.002) { fragColor = vec4(0.0); return; }

  // палитра: тёмно-красный -> оранжевый -> жёлтый -> белый
  vec3 fire = vec3(pow(f, 0.4), pow(f, 1.6) * 0.8, pow(f, 3.6) * 0.7);
  vec3 col = fire * mix(vec3(1.0), baseColor(fract(uv.x + f * 0.2)) * 1.4, 0.5);

  float alpha = clamp(f * u_intensity, 0.0, 0.85) * soundGate();
  fragColor = vec4(col * alpha, alpha);
}
`

// ── SPARKS: искры-угольки взлетают над рамкой ────────────────────────────
const SPARKS_FRAG = COMMON + `
void main(){
  vec2 p = gl_FragCoord.xy;
  float sd = sdBox(p);
  float boxTop = u_box.y + u_box.w;
  // ОПТИМИЗАЦИЯ: маска smoothstep(-1,2,sd) внутри рамки — 0, искры там
  // не видны (alpha=0 => vec4(0)). Пропускаем 12-итерационный цикл для
  // интерьера — вывод побитово тот же.
  if (sd < -1.0) { fragColor = vec4(0.0); return; }

  float v = 0.0;
  vec3 colAcc = vec3(0.0);
  for (int i = 0; i < 12; i++){
    float fi = float(i);
    float seed = hash11(fi * 7.31 + u_seed);
    float rate = 0.5 + hash11(fi * 3.7 + u_seed) * 0.8;
    float life = fract(u_time * rate + seed);
    float x = seed + sin(life * 5.0 + seed * 40.0) * 0.05;
    float rise = 18.0 + hash11(fi * 11.3 + u_seed) * 22.0;
    float y = boxTop + life * rise;
    vec2 sp = vec2(x * u_res.x, y);
    vec2 dv = p - sp;
    float d2 = dot(dv, dv);
    float size = 2.0 + life * 1.8;
    float glow = exp(-d2 / (size * size));
    // без пола: тише звук — тусклее искры, в тишине гаснут полностью
    float gate = u_level * 1.3 + u_beat * 0.5;
    float tw = 0.7 + 0.3 * sin(u_time * 18.0 + seed * 50.0);
    v += glow * (1.0 - life) * gate * tw;
    colAcc += baseColor(fract(seed + u_time * 0.03)) * glow * (1.0 - life);
  }
  // тёплая линия у рамки — тоже от громкости
  v += exp(-abs(sd) * 0.35) * u_level * 0.35;

  float mask = smoothstep(-1.0, 2.0, sd);
  float alpha = clamp(v * u_intensity, 0.0, 0.85) * mask * soundGate();
  vec3 col = colAcc + baseColor(0.5) * 0.1;
  fragColor = vec4(col * alpha, alpha);
}
`

// ── WAVE: одна плавная живая кривая спектра, прижатая к инпуту ───────────
const WAVE_FRAG = COMMON + `
void main(){
  vec2 p = gl_FragCoord.xy;
  vec2 uv = p / u_res;
  float sd = sdBox(p);
  float boxTop = u_box.y + u_box.w;
  // ОПТИМИЗАЦИЯ: маска smoothstep(-1,2,sd) гасит кривую внутри рамки в
  // ноль — пропускаем 5 выборок спектра и шум для интерьера. Вывод тот же.
  if (sd < -1.0) { fragColor = vec4(0.0); return; }
  float x = uv.x;

  // одна плавная кривая: 5-tap сглаживание спектра
  float b0 = sampleBand(clamp(x - 0.03, 0.0, 1.0));
  float b1 = sampleBand(clamp(x - 0.015, 0.0, 1.0));
  float b2 = sampleBand(x);
  float b3 = sampleBand(clamp(x + 0.015, 0.0, 1.0));
  float b4 = sampleBand(clamp(x + 0.03, 0.0, 1.0));
  float band = (b0 + b1 * 2.0 + b2 * 3.0 + b3 * 2.0 + b4) / 9.0;

  // лёгкое живое дрожание
  float wob = (vnoise(vec2(x * 18.0, u_time * 1.2)) - 0.5) * 3.0;

  // кривая прижата к рамке: 4px отступ + амплитуда
  float yLine = boxTop + 4.0 + band * 26.0 + u_beat * 5.0 + wob;
  float dl = abs(p.y - yLine);
  float line = exp(-dl * 0.38);

  float v = line * (0.35 + u_level * 0.45) * u_intensity;
  float mask = smoothstep(-1.0, 2.0, sd);
  float alpha = clamp(v, 0.0, 0.85) * mask * soundGate();
  vec3 col = baseColor(x) * (0.65 + band * 0.6) + vec3(1.0) * line * 0.2;
  fragColor = vec4(col * alpha, alpha);
}
`

// ── SPECTRUM: палочки спектра над верхней гранью инпута ─────────────────
// Только верх: вертикальные палочки одинаковой ширины ~15 CSS px, растут
// от верхней грани вверх; у боковых краёв мягко гаснут — не конфликтуют
// со скруглениями рамки. Боковые/нижние части убраны (выглядели ущербно).
const SPECTRUM_FRAG = COMMON + `
void main(){
  vec2 p = gl_FragCoord.xy;
  vec2 rel = p - u_box.xy;
  float above = rel.y - u_box.w; // >0 выше верхней грани
  // ОПТИМИЗАЦИЯ: глубоко внутри рамки bar=0 и base=0 (маски), а вклад tip
  // < 1e-5 — квантуется в 0 в 8-битном альфа-канале. Пропускаем вычисление
  // палочек для ~85% пикселей канваса — вывод визуально идентичен.
  if (above < -8.0) { fragColor = vec4(0.0); return; }

  // позиция вдоль верхней грани 0..1
  float u = clamp((rel.x + u_box.z) / (2.0 * u_box.z), 0.0, 1.0);

  // палочки одинаковой ширины
  float barW = 15.0 * u_dpr;
  float segs = max(6.0, floor((2.0 * u_box.z) / barW));

  float seg = floor(u * segs);
  float segT = (seg + 0.5) / segs;
  float band = sampleBand(segT);
  float hOut = 2.0 + band * 16.0 + u_beat * 3.0;

  // палочка от грани вверх, мягкие края (не «пиксельно»)
  float bar = smoothstep(hOut + 2.5, hOut - 1.5, above) * smoothstep(-1.5, 1.0, above);
  // градиент внутри палочки: ярче к кончику
  float grad = 0.45 + 0.55 * clamp(above / max(hOut, 1.0), 0.0, 1.0);
  // зазор между палочками
  float segF = fract(u * segs);
  float gap = smoothstep(0.0, 0.3, segF) * smoothstep(1.0, 0.7, segF);
  // у боковых краёв рамки палочки мягко гаснут (скругления)
  float edgeFade = smoothstep(0.0, 0.03, u) * smoothstep(1.0, 0.97, u);
  // светящийся кончик
  float tip = exp(-abs(above - hOut) * 1.1) * 0.7;
  // мягкая подложка вдоль грани (только сверху, внутрь не заходим)
  float baseMask = smoothstep(-1.0, 1.5, above);
  float base = exp(-max(above, 0.0) * 0.45) * (0.15 + u_bass * 0.25) * baseMask;

  float v = (bar * grad + tip) * gap * edgeFade * (0.55 + u_level * 0.35) + base * edgeFade;
  float alpha = clamp(v * u_intensity, 0.0, 0.9) * soundGate();
  vec3 col = baseColor(segT) * (0.6 + band * 0.7) + vec3(1.0) * tip * gap * 0.15;
  fragColor = vec4(col * alpha, alpha);
}
`

const FRAG_BODIES: Record<AudioVisualizerPreset, string> = {
  fire: FIRE_FRAG,
  sparks: SPARKS_FRAG,
  wave: WAVE_FRAG,
  spectrum: SPECTRUM_FRAG
}

/** Идеальные встроенные настройки пресета (пользовательских ползунков нет). */
const EFFECT_TUNING: Record<AudioVisualizerPreset, { intensity: number; gain: number }> = {
  fire: { intensity: 0.75, gain: 1.15 },
  sparks: { intensity: 0.65, gain: 1.3 },
  wave: { intensity: 0.7, gain: 1.15 },
  spectrum: { intensity: 0.85, gain: 1.25 }
}

/** Геометрия канваса под пресет: класс CSS + отступы от инпута (CSS px).
 *  ВАЖНО: значения должны совпадать с CSS-классами (иначе boxTop/boxBottom
 *  в шейдере уедет — так волна «висела в воздухе»). */
const PRESET_LAYOUT: Record<AudioVisualizerPreset, { className: string; top: number; side: number; bottom: number }> = {
  fire: { className: 'chat-input-audio-visualizer--rise', top: 64, side: 6, bottom: 18 },
  sparks: { className: 'chat-input-audio-visualizer--rise', top: 64, side: 6, bottom: 18 },
  wave: { className: 'chat-input-audio-visualizer--rise', top: 64, side: 6, bottom: 18 },
  spectrum: { className: 'chat-input-audio-visualizer--top', top: 24, side: 6, bottom: 6 }
}

const UNIFORM_NAMES = [
  'u_res', 'u_time', 'u_level', 'u_bass', 'u_mid', 'u_treble', 'u_beat',
  'u_intensity', 'u_color', 'u_color2', 'u_colorMode', 'u_bands[0]',
  'u_box', 'u_seed', 'u_dpr'
] as const

function hexRgb(hex: string): [number, number, number] {
  const m = /^#([\da-f]{6})$/i.exec(hex)
  if (!m) return [0.3, 0.62, 1]
  const v = Number.parseInt(m[1], 16)
  return [((v >> 16) & 255) / 255, ((v >> 8) & 255) / 255, (v & 255) / 255]
}

/** Гамма-буст: тихие детали видны, реакция «панчевая». */
function shape(v: number): number {
  return Math.pow(Math.min(1, Math.max(0, v)), 0.72)
}

/** Асимметричное сглаживание (attack/release) — чистая функция вне кадра. */
function toward(target: number, cur: number, up: number, down: number): number {
  return cur + (target - cur) * (target > cur ? up : down)
}

interface AudioVisualizerLayerProps {
  demo?: boolean
}

export function AudioVisualizerLayer({ demo = false }: AudioVisualizerLayerProps) {
  const canvasRef = useRef<HTMLCanvasElement>(null)
  const settingEnabled = useSettingsStore(s => !!s.settings.audioVisualizerEnabled)
  const enabled = demo || settingEnabled
  const preset = normalizeVisualizerPreset(useSettingsStore(s => s.settings.audioVisualizerPreset))
  const colorMode = (useSettingsStore(s => s.settings.audioVisualizerColorMode as string) || 'accent')
  const customColor = (useSettingsStore(s => s.settings.audioVisualizerColor as string) || '#4d9fff')
  const accent = useUIStore(s => s.accentColor)
  const gradient = useUIStore(s => s.accentGradient)
  const frameRef = useRef<AudioFrame | null>(null)
  // wakeRef: покадровый rAF-цикл останавливается в полной тишине (см. draw).
  // Приход нового аудио-кадра (или demo-кадра) будит цикл — иначе после
  // «засыпания» звук не отрисовался бы до следующего кадра.
  const wakeRef = useRef<(() => void) | null>(null)

  useEffect(() => subscribeAudioVisualizer(frame => {
    frameRef.current = frame
    wakeRef.current?.()
  }, demo), [demo])

  useEffect(() => {
    const canvas = canvasRef.current
    const box = canvas?.parentElement
    if (!canvas || !box || !enabled) return
    const gl = canvas.getContext('webgl2', {
      alpha: true,
      premultipliedAlpha: true,
      antialias: false,
      depth: false,
      stencil: false
    })
    if (!gl) {
      console.warn('[audio-visualizer] WebGL2 недоступен — эффекты отключены')
      return
    }

    // ── компиляция программы пресета ────────────────────────────────────
    const compileShader = (type: number, code: string): WebGLShader | null => {
      const sh = gl.createShader(type)
      if (!sh) return null
      gl.shaderSource(sh, code)
      gl.compileShader(sh)
      if (!gl.getShaderParameter(sh, gl.COMPILE_STATUS)) {
        console.error('[audio-visualizer] shader error:', gl.getShaderInfoLog(sh))
        gl.deleteShader(sh)
        return null
      }
      return sh
    }
    const vs = compileShader(gl.VERTEX_SHADER, VERT_SRC)
    const fs = compileShader(gl.FRAGMENT_SHADER, FRAG_BODIES[preset])
    if (!vs || !fs) return
    const program = gl.createProgram()
    if (!program) return
    gl.attachShader(program, vs)
    gl.attachShader(program, fs)
    gl.linkProgram(program)
    gl.deleteShader(vs)
    gl.deleteShader(fs)
    if (!gl.getProgramParameter(program, gl.LINK_STATUS)) {
      console.error('[audio-visualizer] link error:', gl.getProgramInfoLog(program))
      gl.deleteProgram(program)
      return
    }
    gl.useProgram(program)
    const loc: Record<string, WebGLUniformLocation | null> = {}
    for (const name of UNIFORM_NAMES) loc[name] = gl.getUniformLocation(program, name)

    // fullscreen triangle
    const buf = gl.createBuffer()
    gl.bindBuffer(gl.ARRAY_BUFFER, buf)
    gl.bufferData(gl.ARRAY_BUFFER, new Float32Array([-1, -1, 3, -1, -1, 3]), gl.STATIC_DRAW)
    gl.enableVertexAttribArray(0)
    gl.vertexAttribPointer(0, 2, gl.FLOAT, false, 0, 0)
    gl.disable(gl.DEPTH_TEST)
    gl.enable(gl.BLEND)
    gl.blendFunc(gl.ONE, gl.ONE_MINUS_SRC_ALPHA)

    // ── состояние (сглаживание аудио, биты) ─────────────────────────────
    const tuning = EFFECT_TUNING[preset]
    const layout = PRESET_LAYOUT[preset]
    // Цвета кэшируются на время жизни эффекта: regex-парсинг hex два раза
    // в каждом кадре (120/с) — лишняя работа, значения меняются только
    // вместе с настройками (deps эффекта).
    const modeIndex = colorMode === 'rainbow' ? 3 : colorMode === 'gradient' ? 2 : colorMode === 'custom' ? 1 : 0
    const c1 = hexRgb(modeIndex === 1 ? customColor : accent)
    const c2 = hexRgb(gradient?.enabled ? gradient.color2 : accent)
    const dpr = Math.min(window.devicePixelRatio || 1, 2)
    const seed = Math.random() * 100
    const sm = { level: 0, bass: 0, mid: 0, treble: 0, bands: new Float32Array(64) }
    let beat = 0
    let lastBeatAt = 0
    const bassHist: number[] = []

    const resize = () => {
      const rect = canvas.getBoundingClientRect()
      const w = Math.max(2, Math.round(rect.width * dpr))
      const h = Math.max(2, Math.round(rect.height * dpr))
      if (canvas.width !== w || canvas.height !== h) {
        canvas.width = w
        canvas.height = h
      }
    }
    const observer = new ResizeObserver(resize)
    observer.observe(box)
    resize()

    const t0 = performance.now()
    let last = t0
    let raf = 0
    let lost = false
    // В тишине кадр полностью прозрачен (soundGate=0). Чтобы не жечь rAF
    // каждый display-кадр на пустом канвасе, дожидаемся полного «успокоения»
    // сглаживания ниже гейта, один раз стираем канвас и останавливаем цикл.
    // Будит его wake() при приходе нового аудио-кадра.
    const GATE = 0.015          // порог гейта рендерера: sm.level < GATE => кадр прозрачен
    const SETTLE_EPS = 0.0004   // порог «успокоения» уровня (дельта за кадр)
    let clearedSilent = false   // канвас уже стёрт для текущей тишины
    const onLost = (e: Event) => { e.preventDefault(); lost = true; cancelAnimationFrame(raf) }
    canvas.addEventListener('webglcontextlost', onLost)

    const draw = (now: number) => {
      if (lost) return
      const dt = Math.min(0.05, Math.max(0.001, (now - last) / 1000))
      last = now

      // сглаживание входных данных (кадры ~30 FPS -> шейдер 60 FPS)
      const frame = frameRef.current
      const prevLevel = sm.level
      sm.level = toward(shape((frame?.level ?? 0) * tuning.gain), sm.level, 0.55, 0.16)
      sm.bass = toward(shape((frame?.bass ?? 0) * tuning.gain), sm.bass, 0.6, 0.2)
      sm.mid = toward(shape((frame?.mid ?? 0) * tuning.gain), sm.mid, 0.55, 0.18)
      sm.treble = toward(shape((frame?.treble ?? 0) * tuning.gain), sm.treble, 0.55, 0.18)
      const bands = frame?.bands
      for (let i = 0; i < 64; i++) {
        const target = shape((bands?.[i] ?? 0) * tuning.gain)
        sm.bands[i] = toward(target, sm.bands[i], 0.6, 0.22)
      }

      // детект бита: всплеск баса выше скользящего среднего
      bassHist.push(sm.bass)
      if (bassHist.length > 42) bassHist.shift()
      let avg = 0
      for (let i = 0; i < bassHist.length; i++) avg += bassHist[i]
      avg /= Math.max(1, bassHist.length)
      if (sm.bass > 0.16 && sm.bass > avg * 1.25 + 0.04 && now - lastBeatAt > 120) {
        lastBeatAt = now
        beat = 1
      }
      beat *= Math.exp(-dt * 5)

      // ТИШИНА: soundGate()=0 во всех пресетах => весь кадр полностью
      // прозрачен. Стираем последний видимый кадр ОДИН раз, и как только
      // сглаживание успокоилось ниже гейта — останавливаем rAF (не жжём
      // display-кадры). Фаза u_time сохраняется: t0 и now не сбрасываются.
      if (sm.level < GATE) {
        if (!clearedSilent) {
          gl.viewport(0, 0, canvas.width, canvas.height)
          gl.clearColor(0, 0, 0, 0)
          gl.clear(gl.COLOR_BUFFER_BIT)
          clearedSilent = true
        }
        if (Math.abs(sm.level - prevLevel) < SETTLE_EPS) { raf = 0; return }
        raf = requestAnimationFrame(draw)
        return
      }
      clearedSilent = false

      // активный кадр: чистим каждый раз (нужно для корректного blend)
      gl.viewport(0, 0, canvas.width, canvas.height)
      gl.clearColor(0, 0, 0, 0)
      gl.clear(gl.COLOR_BUFFER_BIT)

      // инпут-бокс в GL-координатах (y вверх)
      const sideD = layout.side * dpr
      const boxBottomY = layout.bottom * dpr
      const boxTopY = Math.max(boxBottomY + 2, canvas.height - layout.top * dpr)
      const boxCx = canvas.width / 2
      const boxCy = (boxBottomY + boxTopY) / 2
      const boxHx = Math.max(1, (canvas.width - 2 * sideD) / 2)
      const boxHy = Math.max(1, (boxTopY - boxBottomY) / 2)

      gl.useProgram(program)
      if (loc['u_res']) gl.uniform2f(loc['u_res'], canvas.width, canvas.height)
      if (loc['u_time']) gl.uniform1f(loc['u_time'], (now - t0) / 1000)
      if (loc['u_level']) gl.uniform1f(loc['u_level'], sm.level)
      if (loc['u_bass']) gl.uniform1f(loc['u_bass'], sm.bass)
      if (loc['u_mid']) gl.uniform1f(loc['u_mid'], sm.mid)
      if (loc['u_treble']) gl.uniform1f(loc['u_treble'], sm.treble)
      if (loc['u_beat']) gl.uniform1f(loc['u_beat'], beat)
      if (loc['u_intensity']) gl.uniform1f(loc['u_intensity'], tuning.intensity)
      if (loc['u_color']) gl.uniform3f(loc['u_color'], c1[0], c1[1], c1[2])
      if (loc['u_color2']) gl.uniform3f(loc['u_color2'], c2[0], c2[1], c2[2])
      if (loc['u_colorMode']) gl.uniform1i(loc['u_colorMode'], modeIndex)
      if (loc['u_bands[0]']) gl.uniform1fv(loc['u_bands[0]'], sm.bands)
      if (loc['u_box']) gl.uniform4f(loc['u_box'], boxCx, boxCy, boxHx, boxHy)
      if (loc['u_seed']) gl.uniform1f(loc['u_seed'], seed)
      if (loc['u_dpr']) gl.uniform1f(loc['u_dpr'], dpr)
      gl.drawArrays(gl.TRIANGLES, 0, 3)
      raf = requestAnimationFrame(draw)
    }

    // wake: перезапуск остановленного цикла при приходе нового аудио-кадра
    // (в т.ч. demo). Пока цикл жив (raf != 0) — no-op.
    const wake = () => {
      if (lost || raf) return
      last = performance.now()
      raf = requestAnimationFrame(draw)
    }
    wakeRef.current = wake
    raf = requestAnimationFrame(draw)

    return () => {
      wakeRef.current = null
      cancelAnimationFrame(raf)
      observer.disconnect()
      canvas.removeEventListener('webglcontextlost', onLost)
      gl.deleteBuffer(buf)
      gl.deleteProgram(program)
    }
  }, [enabled, preset, colorMode, customColor, accent, gradient])

  if (!enabled) return null
  return (
    <canvas
      ref={canvasRef}
      className={`chat-input-audio-visualizer ${PRESET_LAYOUT[preset].className}`}
      aria-hidden="true"
    />
  )
}
