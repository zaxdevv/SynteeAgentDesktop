import type { BgMessage, BgStyle } from './bg-types'

// ── Шейдерный воркер для анимированного фона ─────────────────────────
// 5 эффектов, все на чистых фрагментных шейдерах (fullscreen quad).
// Никаких GL_POINTS-частиц — они «закрашивали» фон сплошным слоем.
// rAF 60fps, главный поток свободен.

// ── GLSL общий вертекс: один quad на весь экран ──────────────────────
const VERT_SRC = `#version 300 es
layout(location=0) in vec2 a_pos;
out vec2 v_uv;
void main(){
  v_uv = a_pos * 0.5 + 0.5;
  gl_Position = vec4(a_pos, 0.0, 1.0);
}`

// ── Общий код: uniforms + хелперы шума ───────────────────────────────
const COMMON = `#version 300 es
precision highp float;
in vec2 v_uv;
out vec4 fragColor;
uniform vec2  u_res;
uniform float u_time;
uniform float u_speed;
uniform float u_opacity;
uniform vec3  u_color;
uniform float u_seed;
uniform float u_intensity;
uniform float u_param;   // per-style: scale / warp / density / linkDist
uniform vec2  u_mouse;    // позиция мыши в UV (0-1), Y перевёрнут; (-100,-100) = вне экрана
uniform float u_count;    // кол-во частиц (network)
uniform float u_scale;    // render scale (1.0=full, 0.5=half, 0.3=network) — для px-размеров

// ── hash & noise ──
float hash11(float p){ p = fract(p*443.8975); p += dot(p, p+19.19); return fract(p*0.6019); }
vec2  hash22(vec2 p){ vec3 q = fract(vec3(p.xyx)*vec3(443.897, 444.567, 445.345)); q += dot(q, q.yzx+19.19); return fract((q.xx+q.yz)*q.zy); }
float hash21(vec2 p){ return hash11(p.x + p.y*127.1); }

float vnoise(vec2 p){
  vec2 i = floor(p), f = fract(p);
  vec2 u = f*f*(3.0-2.0*f);
  float a = hash21(i);
  float b = hash21(i+vec2(1,0));
  float c = hash21(i+vec2(0,1));
  float d = hash21(i+vec2(1,1));
  return mix(mix(a,b,u.x), mix(c,d,u.x), u.y);
}

float fbm(vec2 p){
  float v = 0.0, a = 0.5;
  for(int i=0;i<6;i++){ v += a*vnoise(p); p *= 2.02; a *= 0.5; }
  return v;
}

float fbm4(vec2 p){
  float v = 0.0, a = 0.5;
  for(int i=0;i<4;i++){ v += a*vnoise(p); p *= 2.03; a *= 0.5; }
  return v;
}
`

function makeFrag(body: string): string {
  return `${COMMON}\n${body}\n`
}

// ══════════════════════════════════════════════════════════════════════
//  1. AURORA — северное сияние: вертикальные занавесы света + звёзды
// ══════════════════════════════════════════════════════════════════════
const AURORA_FRAG = makeFrag(`
void main(){
  vec2 uv = v_uv;
  float asp = u_res.x / u_res.y;
  uv.x *= asp;
  float t = u_time * u_speed * 0.3;

  // Звёзды на тёмном небе
  vec2 sg = uv * vec2(200.0, 120.0);
  float starN = hash21(floor(sg));
  float star = smoothstep(0.992, 1.0, starN) * (0.5 + 0.5*sin(t*3.0 + starN*30.0));

  // Занавесы: несколько слоёв fbm, смещённых по вертикали
  float col = 0.0;
  for(int i=0; i<4; i++){
    float fi = float(i);
    float layer = fbm(vec2(uv.x*1.5 + t*(0.4+fi*0.15), uv.y*2.0 + fi*3.0 + t*0.2));
    float curtain = smoothstep(0.35, 0.65, layer);
    // вертикальное затухание к верху
    float vfade = smoothstep(0.0, 0.3, uv.y) * smoothstep(1.0, 0.4, uv.y);
    col += curtain * vfade * (0.7 - fi*0.12);
  }

  // Цвет: mix акцентного цвета с холодным оттенком в нижней части
  vec3 cool = vec3(0.3, 0.7, 1.0);
  vec3 warm = u_color;
  vec3 auroraCol = mix(cool, warm, smoothstep(0.3, 0.8, uv.y));

  float alpha = (col * 0.6 + star * 0.4) * u_opacity * u_intensity;
  fragColor = vec4(auroraCol * (col + star*0.5), alpha);
}`)

// ══════════════════════════════════════════════════════════════════════
//  2. SILK — переливающийся шёлк: плавные волны с иридесцентным цветом
// ══════════════════════════════════════════════════════════════════════
const SILK_FRAG = makeFrag(`
void main(){
  vec2 uv = v_uv;
  float asp = u_res.x / u_res.y;
  uv.x *= asp;
  float t = u_time * u_speed * 0.15;
  float scale = u_param; // 2..8

  // Domain warp: искажаем координаты через fbm
  vec2 q = vec2(fbm(uv*scale + t), fbm(uv*scale + vec2(1.7, 9.2) + t*0.7));
  vec2 r = vec2(fbm(uv*scale + q + vec2(0.0, 0.0) + t*0.3),
                fbm(uv*scale + q + vec2(5.2, 1.3) + t*0.5));
  float f = fbm(uv*scale + r);

  // Иридесцентный цвет: 3 оттенка, смешанные по f и r
  vec3 c1 = u_color;
  vec3 c2 = vec3(0.5, 0.3, 0.9);
  vec3 c3 = vec3(0.2, 0.8, 0.6);
  vec3 col = mix(c1, c2, smoothstep(0.3, 0.6, f));
  col = mix(col, c3, smoothstep(0.5, 0.8, r.x));

  // Блики: тонкие линии складок шёлка
  float fold = smoothstep(0.45, 0.5, f) - smoothstep(0.5, 0.55, f);
  col += fold * 0.8;

  float alpha = f * u_opacity * u_intensity * 0.7;
  fragColor = vec4(col * (0.4 + f*0.6), alpha);
}`)

// ══════════════════════════════════════════════════════════════════════
//  3. WARP — гиперпространство: летящие звёзды со шлейфами из центра
// ══════════════════════════════════════════════════════════════════════
const WARP_FRAG = makeFrag(`
void main(){
  vec2 uv = v_uv - 0.5;
  float asp = u_res.x / u_res.y;
  uv.x *= asp;
  float t = u_time * u_speed;

  float r = length(uv);
  float a = atan(uv.y, uv.x);

  // Спиральное искажение угла
  a += sin(r*8.0 - t*1.5) * 0.3;

  // Звёздные линии: радиальные полосы
  float stripes = 0.0;
  float warpAmt = u_param; // 0.5..3
  for(int i=0; i<5; i++){
    float fi = float(i);
    float angle = a + fi * 1.2566; // ~2π/5
    float streak = abs(sin(angle * 3.0 + t * (1.0 + fi*0.3)));
    streak = pow(streak, 8.0);
    // шлейф от центра наружу
    float trail = smoothstep(0.0, 0.5, r) * smoothstep(1.2, 0.4, r);
    stripes += streak * trail * warpAmt;
  }

  // Мерцающие звёзды
  float starG = hash21(floor(uv * 80.0));
  float stars = smoothstep(0.98, 1.0, starG) * (0.5 + 0.5*sin(t*5.0 + starG*20.0));
  stars *= smoothstep(0.0, 0.15, r);

  // Центральное свечение
  float glow = exp(-r * 3.0) * 0.5;

  float intensity = (stripes * 0.5 + stars * 0.8 + glow) * u_opacity * u_intensity;
  vec3 col = u_color * (stripes + glow) + vec3(1.0) * stars;
  fragColor = vec4(col, intensity);
}`)

// ══════════════════════════════════════════════════════════════════════
//  4. NEBULA — космическая туманность: облака + мерцающие звёзды
// ══════════════════════════════════════════════════════════════════════
const NEBULA_FRAG = makeFrag(`
void main(){
  vec2 uv = v_uv;
  float asp = u_res.x / u_res.y;
  uv.x *= asp;
  float t = u_time * u_speed * 0.08;
  float scale = u_param; // 2..6

  // Многослойный fbm для облаков
  vec2 p = uv * scale;
  float n1 = fbm(p + t);
  float n2 = fbm(p * 2.0 + n1 * 1.5 + vec2(3.1, 1.7) + t*0.5);
  float clouds = n2;

  // Плотность туманности
  float density = smoothstep(0.35, 0.75, clouds);

  // Цвет: два оттенка + акцент
  vec3 deep = vec3(0.1, 0.05, 0.3);
  vec3 mid = vec3(0.4, 0.2, 0.7);
  vec3 accent = u_color;
  vec3 col = mix(deep, mid, smoothstep(0.3, 0.6, clouds));
  col = mix(col, accent, smoothstep(0.55, 0.8, clouds) * 0.7);

  // Мерцающие звёзды поверх
  vec2 sg = uv * vec2(150.0, 90.0);
  float starN = hash21(floor(sg));
  float stars = smoothstep(0.985, 1.0, starN) * (0.4 + 0.6*sin(t*8.0 + starN*40.0));

  float alpha = (density * 0.55 + stars * 0.6) * u_opacity * u_intensity;
  col += vec3(1.0) * stars * 0.8;
  fragColor = vec4(col, alpha);
}`)

// ══════════════════════════════════════════════════════════════════════
//  5. PLASMA — жидкая плазма: иридесцентное свечение с волнами
// ══════════════════════════════════════════════════════════════════════
const PLASMA_FRAG = makeFrag(`
void main(){
  vec2 uv = v_uv;
  float asp = u_res.x / u_res.y;
  uv.x *= asp;
  float t = u_time * u_speed * 0.2;
  float scale = u_param; // 3..10

  // Классическая плазма: сумма синусоид
  float p1 = sin(uv.x*scale + t);
  float p2 = sin(uv.y*scale*0.8 + t * 1.3);
  float p3 = sin((uv.x+uv.y)*scale*0.6 + t*0.7);
  float p4 = sin(length(uv-0.5)*scale*4.0 + t*1.5);
  float plasma = (p1 + p2 + p3 + p4) * 0.25;

  // Иридесцентная палитра через косинус
  vec3 col = 0.5 + 0.5 * cos(3.14159 * (plasma * 2.0 + vec3(0.0, 0.33, 0.67)) + t);

  // Подмешиваем акцентный цвет
  col = mix(col, u_color, 0.35);

  // Свечение: усиливаем яркие зоны
  float glow = smoothstep(0.2, 0.8, plasma + 0.5);
  col *= 0.3 + glow * 0.7;

  float alpha = (0.3 + glow * 0.5) * u_opacity * u_intensity;
  fragColor = vec4(col, alpha);
}`)

// ══════════════════════════════════════════════════════════════════════
//  6. CAUSTICS — подводные блики: переливающийся свет сквозь воду
// ══════════════════════════════════════════════════════════════════════
const CAUSTICS_FRAG = makeFrag(`
void main(){
  vec2 uv = v_uv;
  float asp = u_res.x / u_res.y;
  uv.x *= asp;
  float t = u_time * u_speed * 0.2;
  float scale = u_param; // 3..10

  vec2 p = (uv - 0.5) * scale;

  // Многослойный domain warp — основа каустики
  vec2 q = vec2(fbm(p + t), fbm(p + vec2(5.1, 1.3) + t * 0.8));
  vec2 r = vec2(fbm(p + q * 2.0 + vec2(1.7, 9.2) + t * 0.5),
                fbm(p + q * 2.0 + vec2(8.3, 2.8) + t * 0.6));
  float f = fbm(p + r * 2.0);

  // Острые пики каустики — как свет, прошедший сквозь волны
  float c1 = pow(abs(sin(f * 6.28318 + t * 1.2)), 5.0);
  c1 *= smoothstep(0.15, 0.45, f) * smoothstep(0.95, 0.5, f);

  // Второй слой — крупнее, медленнее
  float f2 = fbm(p * 1.3 + r * 1.5 + t * 0.3);
  float c2 = pow(abs(sin(f2 * 6.28318 - t * 0.7)), 5.0);
  c2 *= smoothstep(0.2, 0.5, f2) * smoothstep(0.9, 0.4, f2);

  float total = c1 * 0.7 + c2 * 0.3;

  // Цвет: акцент с аквамариновым оттенком
  vec3 aqua = vec3(0.2, 0.85, 1.0);
  vec3 col = mix(aqua, u_color, 0.4);

  // Яркие пики — свечение
  col *= 0.5 + total * 2.0;

  float alpha = total * u_opacity * u_intensity * 1.2;
  fragColor = vec4(col, alpha);
}`)

// ══════════════════════════════════════════════════════════════════════
//  7. VORTEX — вращающаяся чёрная дыра: спиральные рукава, гравитационное
//  линзирование, светящееся ядро аккреционного диска
// ══════════════════════════════════════════════════════════════════════
const VORTEX_FRAG = makeFrag(`
void main(){
  vec2 uv = v_uv - 0.5;
  float asp = u_res.x / u_res.y;
  uv.x *= asp;
  float t = u_time * u_speed * 0.4;
  float scale = u_param; // 2..8

  float r = length(uv);
  float a = atan(uv.y, uv.x);

  // Гравитационное линзирование: искажение угла от расстояния
  float lens = 1.0 / (r * scale + 0.3);
  float da = a + t + lens;

  // Спиральные рукава (логарифмическая спираль)
  float arms = sin(da * 3.0 + log(r * scale + 1.0) * 4.0);
  arms = smoothstep(0.3, 0.8, arms * 0.5 + 0.5);
  arms *= smoothstep(0.0, 0.12, r) * smoothstep(0.7, 0.2, r);

  // Тонкие вторичные спирали (встречное вращение)
  float arms2 = sin(da * 6.0 - log(r * scale + 1.0) * 3.0 + t * 2.0);
  arms2 = smoothstep(0.5, 0.9, arms2 * 0.5 + 0.5) * 0.35;

  // Пыльевые полосы через fbm
  float dust = fbm(vec2(da * 2.0, r * scale * 3.0) + t * 0.5);
  dust = smoothstep(0.4, 0.65, dust) * 0.4;
  dust *= smoothstep(0.05, 0.3, r) * smoothstep(0.7, 0.3, r);

  // Ядро — аккреционный диск
  float core = exp(-r * 4.5) * 0.9;

  float intensity = (arms + arms2 + dust + core) * u_opacity * u_intensity;

  // Цвет: акцент для спиралей, тёплый — для ядра
  vec3 col = u_color * (arms + arms2 + dust) + vec3(1.0, 0.85, 0.5) * core;
  col *= 0.4 + intensity * 0.6;

  fragColor = vec4(col, intensity);
}`)

// ══════════════════════════════════════════════════════════════════════
//  8. FLOW — текучие линии тока: curl-noise поле, как ветер/жидкость
//  с органическими стриктурными линиями
// ══════════════════════════════════════════════════════════════════════
const FLOW_FRAG = makeFrag(`
void main(){
  vec2 uv = v_uv;
  float asp = u_res.x / u_res.y;
  uv.x *= asp;
  float t = u_time * u_speed * 0.12;
  float scale = u_param; // 3..10

  vec2 p = uv * scale;

  // Domain warp для органического потока
  vec2 q = vec2(fbm4(p + t), fbm4(p + vec2(5.1, 1.3) + t * 0.8));

  // Угол потока из шумового поля
  float n = fbm4(p + q * 1.5 + t * 0.3);
  float angle = n * 12.566; // 4π

  // Линии тока: сэмплируем вдоль направления потока
  vec2 dir = vec2(cos(angle), sin(angle));
  float stream = 0.0;
  float wsum = 0.0;
  for(int i = 0; i < 5; i++){
    float fi = float(i);
    vec2 sp = p + dir * fi * 0.3;
    float w = 1.0 - fi * 0.15;
    stream += fbm4(sp) * w;
    wsum += w;
  }
  stream /= wsum;

  // Резкие стримлайны
  float lines = smoothstep(0.35, 0.55, stream) - smoothstep(0.55, 0.7, stream);
  float fill = smoothstep(0.3, 0.7, stream);

  // Иридесцентная окраска
  vec3 col = mix(u_color * 0.4, u_color, fill);
  col += lines * u_color * 1.5;

  // Яркие блики
  float highlight = smoothstep(0.7, 0.85, n);
  col += highlight * 0.4;

  float alpha = (fill * 0.4 + lines * 0.6 + highlight * 0.3) * u_opacity * u_intensity;
  fragColor = vec4(col, alpha);
}`)

// ══════════════════════════════════════════════════════════════════════
//  9. CRYSTAL — кристаллические ячейки Вороного со светящимися гранями
//  и иридесцентной окраской
// ══════════════════════════════════════════════════════════════════════
const CRYSTAL_FRAG = makeFrag(`
// Voronoi: возвращает (F1, F2, cellID)
vec3 voronoi(vec2 p){
  vec2 n = floor(p);
  vec2 f = fract(p);
  float f1 = 1e9, f2 = 1e9;
  float id = 0.0;
  for(int j = -1; j <= 1; j++){
    for(int i = -1; i <= 1; i++){
      vec2 g = vec2(float(i), float(j));
      vec2 o = hash22(n + g);
      // Анимация позиций ячеек
      o = 0.5 + 0.5 * sin(u_time * u_speed * 0.3 + 6.28318 * o);
      vec2 r = g + o - f;
      float d = dot(r, r);
      if(d < f1){ f2 = f1; f1 = d; id = n.x + g.x + (n.y + g.y) * 31.0; }
      else if(d < f2){ f2 = d; }
    }
  }
  return vec3(sqrt(f1), sqrt(f2), id);
}

void main(){
  vec2 uv = v_uv;
  float asp = u_res.x / u_res.y;
  uv.x *= asp;
  float t = u_time * u_speed * 0.1;
  float scale = u_param; // 3..10

  vec2 p = uv * scale;
  vec3 v = voronoi(p);
  float f1 = v.x;
  float f2 = v.y;
  float id = v.z;

  // Грани: где F2 - F1 мало
  float edge = 1.0 - smoothstep(0.0, 0.08, f2 - f1);

  // Иридесцентная окраска по ID ячейки
  vec3 col = 0.5 + 0.5 * cos(6.28318 * (id * 0.07 + vec3(0.0, 0.33, 0.67)));
  col = mix(col, u_color, 0.35);

  // Тёмный интерьер, яркие грани
  col *= 0.3 + (1.0 - edge) * 0.2;
  col += edge * u_color * 2.5;

  // Пульсация по ячейкам
  float pulse = 0.5 + 0.5 * sin(t * 2.0 + id);
  col *= 0.7 + pulse * 0.3;

  float alpha = (0.2 + edge * 0.8) * u_opacity * u_intensity;
  fragColor = vec4(col, alpha);
}`)

// ══════════════════════════════════════════════════════════════════════
//  10. MAGMA — метаболы: жидкие капли, сливающиеся и разрывающиеся.
//  Мышь — седьмая капля: водишь по экрану — капли обтекают и сливаются.
// ══════════════════════════════════════════════════════════════════════
const MAGMA_FRAG = makeFrag(`
void main(){
  vec2 uv = v_uv;
  float asp = u_res.x / u_res.y;
  uv.x *= asp;
  float t = u_time * u_speed * 0.3;
  float size = u_param; // 3..8

  // Поле метаболов: 6 капель на орбитах + мышь
  float field = 0.0;
  for(int i = 0; i < 6; i++){
    float fi = float(i);
    float a = t * (0.4 + fi * 0.06) + fi * 1.047;
    vec2 c = vec2(
      0.5 * asp + cos(a + fi * 0.7) * (0.28 + 0.10 * sin(t * 0.6 + fi)),
      0.5 + sin(a * 1.13 + fi * 1.9) * (0.24 + 0.08 * cos(t * 0.5 + fi * 2.0))
    );
    float r = (0.09 + 0.04 * sin(t * 0.9 + fi * 1.7)) * size * 0.2;
    vec2 dv = uv - c;
    field += r * r / (dot(dv, dv) + 1e-5);
  }
  // Мышь — седьмая капля
  if(u_mouse.x >= 0.0 && u_mouse.x <= 1.0 && u_mouse.y >= 0.0 && u_mouse.y <= 1.0){
    vec2 m = vec2(u_mouse.x * asp, u_mouse.y);
    vec2 dm = uv - m;
    field += 0.018 / (dot(dm, dm) + 1e-5);
  }

  // Тело / кромка / ореол
  float body = smoothstep(1.0, 1.25, field);
  float rim  = smoothstep(0.75, 1.0, field) - body;
  float halo = smoothstep(0.25, 0.9, field) * 0.4;

  // Чем глубже внутри — тем горячее
  vec3 hot = vec3(1.0, 0.9, 0.7);
  vec3 col = mix(u_color, hot, smoothstep(1.3, 2.4, field));

  float alpha = (body * 0.55 + rim * 0.8 + halo) * u_opacity * u_intensity;
  fragColor = vec4(col * (0.6 + body * 0.4 + rim * 0.6), alpha);
}`)

// ══════════════════════════════════════════════════════════════════════
//  11. INTERFERENCE — интерференция волн от нескольких источников.
//  Круговые волны от 3 точек + мышь = 4-й источник. Красивые полосы.
// ══════════════════════════════════════════════════════════════════════
const INTERFERENCE_FRAG = makeFrag(`
void main(){
  vec2 uv = v_uv;
  float asp = u_res.x / u_res.y;
  uv.x *= asp;
  float t = u_time * u_speed * 0.5;
  float scale = u_param; // 5..20 (длина волны)

  // 3 фиксированных источника
  vec2 s1 = vec2(0.25 * asp, 0.35);
  vec2 s2 = vec2(0.75 * asp, 0.30);
  vec2 s3 = vec2(0.50 * asp, 0.80);

  float d1 = length(uv - s1) * scale;
  float d2 = length(uv - s2) * scale;
  float d3 = length(uv - s3) * scale;

  // sin(d - ωt) / d → круговая волна, затухающая от центра
  float wave = 0.0;
  wave += sin(d1 - t * 2.0) / max(d1, 1.0);
  wave += sin(d2 - t * 2.0) / max(d2, 1.0);
  wave += sin(d3 - t * 2.0) / max(d3, 1.0);

  // Мышь — 4-й источник (усиленный)
  if(u_mouse.x >= 0.0 && u_mouse.x <= 1.0){
    vec2 ms = vec2(u_mouse.x * asp, u_mouse.y);
    float dm = length(uv - ms) * scale;
    wave += sin(dm - t * 3.0) / max(dm, 1.0) * 1.5;
  }

  // Нормализация
  wave = wave * 0.25 + 0.5;
  wave = smoothstep(0.15, 0.85, wave);

  // Цвет: акцент с интерференционными полосами
  vec3 col = mix(u_color * 0.25, u_color, wave);

  // Яркие линии интерференции
  float lines = smoothstep(0.6, 0.85, wave) - smoothstep(0.85, 1.0, wave);
  col += lines * u_color * 2.0;

  float alpha = wave * u_opacity * u_intensity * 0.55;
  fragColor = vec4(col, alpha);
}`)

// ══════════════════════════════════════════════════════════════════════
//  12. HEXGRID — кристаллическая энергосетка: сотовая решётка со
//  светящимися гранями, по сотам бегут импульсы, мышь подсвечивает соты.
// ══════════════════════════════════════════════════════════════════════
const HEXGRID_FRAG = makeFrag(`
// Расстояние до центра гекса (в гекс-метрике)
float HexDist(vec2 p){
  p = abs(p);
  return max(dot(p, vec2(0.5, 0.8660254)), p.x);
}

// Гекс-тайлинг: возвращает (локальные координаты, id ячейки)
vec4 HexCoords(vec2 uv){
  vec2 r = vec2(1.0, 1.7320508);
  vec2 h = r * 0.5;
  vec2 a = mod(uv, r) - h;
  vec2 b = mod(uv - h, r) - h;
  vec2 gv = dot(a, a) < dot(b, b) ? a : b;
  return vec4(gv, uv - gv);
}

void main(){
  vec2 uv = v_uv;
  float asp = u_res.x / u_res.y;
  uv.x *= asp;
  float t = u_time * u_speed * 0.35;
  float scale = u_param; // 2..8

  vec2 p = uv * scale * 6.0;
  vec4 hc = HexCoords(p);
  vec2 gv = hc.xy;   // локальные координаты внутри гекса
  vec2 id = hc.zw;   // id ячейки (угол решётки)

  // Расстояние до грани гекса
  float d = 0.5 - HexDist(gv);
  float edge  = smoothstep(0.06, 0.0, d);  // сама грань
  float inner = smoothstep(0.0, 0.5, d);   // к центру ячейки

  // 4 импульса бегут вдоль направлений решётки, освещая соты
  float pulse = 0.0;
  for(int i = 0; i < 4; i++){
    float fi = float(i);
    float ang = fi * 1.0472 + 0.5236;   // направления гекс-решётки
    vec2 dir = vec2(cos(ang), sin(ang));
    float phase = fract(t * 0.13 + fi * 0.37);
    vec2 pos = dir * phase * 14.0 + vec2(-5.0 + fi * 3.5, -4.0 + fi * 2.0);
    float dd = length(id - pos);
    pulse += exp(-dd * dd * 0.55) * (1.0 - phase * 0.5);
  }

  // Мышь подсвечивает соты вокруг курсора
  float mg = 0.0;
  if(u_mouse.x >= 0.0 && u_mouse.x <= 1.0 && u_mouse.y >= 0.0 && u_mouse.y <= 1.0){
    vec2 m = vec2(u_mouse.x * asp, u_mouse.y) * scale * 6.0;
    mg = exp(-dot(id - m, id - m) * 0.5);
  }

  // Иридесцентный оттенок по ячейке
  float cid = id.x * 0.17 + id.y * 0.31;
  vec3 cellCol = 0.5 + 0.5 * cos(6.28318 * (cid + vec3(0.0, 0.33, 0.67)));
  cellCol = mix(cellCol, u_color, 0.45);

  float lit = clamp(pulse + mg, 0.0, 1.5);

  vec3 col = cellCol * (0.15 + lit * 0.85);
  col += u_color * edge * (0.35 + lit * 1.2);

  float alpha = (inner * (0.10 + lit * 0.35) + edge * (0.3 + lit * 0.7))
              * u_opacity * u_intensity;
  fragColor = vec4(col, alpha);
}`)

// ══════════════════════════════════════════════════════════════════════
//  13. OIL — нефтяная плёнка на воде: тонкоплёночная интерференция,
//  радужные разводы бензина, медленно плывущие по тёмной воде
// ══════════════════════════════════════════════════════════════════════
const OIL_FRAG = makeFrag(`
void main(){
  vec2 uv = v_uv;
  float asp = u_res.x / u_res.y;
  uv.x *= asp;
  float t = u_time * u_speed * 0.06;
  float scale = u_param; // 2..6

  vec2 p = uv * scale;
  vec2 q = vec2(fbm(p + t), fbm(p + vec2(4.7, 2.1) - t * 0.5));
  vec2 r = vec2(fbm(p + q * 2.2 + vec2(1.7, 9.2) + t * 0.3),
                fbm(p + q * 2.2 + vec2(8.3, 2.8) - t * 0.4));
  float f = fbm(p + r * 1.8);

  // Плёнка есть только там, где f высок
  float film = smoothstep(0.25, 0.55, f);

  // Толщина плёнки → интерференционные радужные полосы
  float thick = (f - 0.25) * 6.0 + r.x * 2.0;
  vec3 iri = 0.5 + 0.5 * cos(6.28318 * (thick + vec3(0.0, 0.33, 0.67)));
  iri = mix(iri, u_color, 0.22);

  // Тёмная вода под плёнкой
  vec3 col = mix(vec3(0.02, 0.03, 0.05), iri, film);

  // Блик на плёнке
  float sheen = smoothstep(0.6, 0.85, f) * 0.35;
  col += sheen;

  float alpha = (film * 0.6 + sheen) * u_opacity * u_intensity;
  fragColor = vec4(col, alpha);
}`)

// ══════════════════════════════════════════════════════════════════════
//  14. SOLAR — солнце: кипящая грануляция поверхности в полярных
//  координатах + мерцающая корона вокруг диска
// ══════════════════════════════════════════════════════════════════════
const SOLAR_FRAG = makeFrag(`
void main(){
  vec2 uv = v_uv - 0.5;
  float asp = u_res.x / u_res.y;
  uv.x *= asp;
  float t = u_time * u_speed * 0.25;
  float scale = u_param; // 2..8 — размер гранул

  float r = length(uv);
  float a = atan(uv.y, uv.x);

  // Грануляция: острые кипящие зёрна в полярных координатах
  vec2 gp = vec2(a * 2.0, r * scale * 3.0) + vec2(t * 0.15, -t * 0.4);
  float g = fbm(gp);
  g = smoothstep(0.35, 0.75, g);

  // Диск солнца с мягкой кромкой
  float disc = smoothstep(0.32, 0.30, r);
  float limb = exp(-abs(r - 0.30) * 25.0) * 0.6;  // светящийся край

  // Температура: горячие пятна → белее
  vec3 hot  = vec3(1.0, 0.95, 0.8);
  vec3 mid  = u_color * 1.2;
  vec3 deep = u_color * 0.4;
  vec3 col = mix(deep, mid, g);
  col = mix(col, hot, smoothstep(0.7, 0.95, g));

  // Корона: угловое мерцание вокруг диска
  float cor = fbm(vec2(a * 3.0 + t * 0.2, r * 4.0 - t * 0.5));
  float corona = exp(-r * 4.5) * (0.5 + cor);

  col = mix(col, u_color * 0.8, corona * 0.6);
  col += hot * (corona * 0.3 + limb * 0.5);

  float alpha = (disc * (0.35 + g * 0.5) + corona * 0.55 + limb * 0.4)
              * u_opacity * u_intensity;
  fragColor = vec4(col, alpha);
}`)

// ══════════════════════════════════════════════════════════════════════
//  15. DREAM — мечта: мягкие пастельные морфящиеся градиенты,
//  как живые обои. Никаких резких границ, только плавные переливы
// ══════════════════════════════════════════════════════════════════════
const DREAM_FRAG = makeFrag(`
void main(){
  vec2 uv = v_uv;
  float asp = u_res.x / u_res.y;
  uv.x *= asp;
  float t = u_time * u_speed * 0.05;
  float scale = u_param; // 1..4

  vec2 p = uv * scale;

  // Очень плавный низкочастотный warp
  vec2 q = vec2(fbm4(p * 0.6 + t), fbm4(p * 0.6 + vec2(8.3, 2.8) - t * 0.7));
  float f = fbm4(p * 0.8 + q * 1.6);

  // Пастельная палитра вокруг акцента: холодный и тёплый сдвиги
  vec3 c1 = u_color;
  vec3 c2 = u_color * vec3(0.7, 0.85, 1.3);
  vec3 c3 = u_color * vec3(1.3, 0.9, 0.8);
  vec3 col = mix(c1, c2, smoothstep(0.2, 0.8, f));
  col = mix(col, c3, smoothstep(0.4, 1.0, q.x));

  // Мягкое свечение — никаких резких границ
  col *= 0.35 + f * 0.5;
  col += u_color * 0.12;

  float alpha = (0.25 + f * 0.4) * u_opacity * u_intensity;
  fragColor = vec4(col, alpha);
}`)

// ══════════════════════════════════════════════════════════════════════
//  16. SMOKE — объёмный дым: стелется вверх, тонкие волокна-клубы,
//  боковой дрейф от шума, мягкое свечение изнутри
// ══════════════════════════════════════════════════════════════════════
const SMOKE_FRAG = makeFrag(`
void main(){
  vec2 uv = v_uv;
  float asp = u_res.x / u_res.y;
  uv.x *= asp;
  float t = u_time * u_speed * 0.1;
  float scale = u_param; // 2..8

  // Вертикальное сжатие + адвекция вверх
  vec2 p = vec2(uv.x * scale * 1.2, uv.y * scale * 0.45 - t);

  // Боковой дрейф от шума
  float drift = fbm4(vec2(uv.y * scale * 0.8 - t, 7.7)) - 0.5;
  p.x += drift * 1.5;

  vec2 q = vec2(fbm4(p + t * 0.3), fbm4(p + vec2(3.1, 5.7) - t * 0.2));
  float f = fbm(p + q * 1.5);

  // Клубы: ridged-шум — тонкие волокна дыма
  float wisp = 1.0 - abs(2.0 * f - 1.0);
  wisp = pow(wisp, 2.5);

  // Затухание к низу и верху
  float vfade = smoothstep(0.0, 0.25, uv.y) * smoothstep(1.05, 0.55, uv.y);

  vec3 col = mix(u_color * 0.5, u_color, wisp);
  col += u_color * 0.15;

  float alpha = wisp * vfade * u_opacity * u_intensity * 0.8;
  fragColor = vec4(col, alpha);
}`)

// ══════════════════════════════════════════════════════════════════════
//  17. TIDE — прилив: биолюминесцентные волны накатывают снизу,
//  светящиеся гребни с искрящейся пеной
// ══════════════════════════════════════════════════════════════════════
const TIDE_FRAG = makeFrag(`
void main(){
  vec2 uv = v_uv;
  float asp = u_res.x / u_res.y;
  uv.x *= asp;
  float t = u_time * u_speed * 0.3;
  float waves = u_param; // 2..6

  float glow = 0.0;
  for(int i = 0; i < 6; i++){
    if(float(i) >= waves) break;
    float fi = float(i);
    // Волна накатывает снизу вверх, своя фаза и скорость
    float base = 0.10 + fi * (0.75 / waves);
    float ph = fract(t * 0.13 + fi * 0.37);
    float y = base + ph * (0.85 / waves);
    // Рельеф гребня — каждый волнистый по-своему
    float xw = fbm4(vec2(uv.x * 3.0 + fi * 17.0, fi * 7.7)) - 0.5;
    y += xw * 0.08;
    // Гребень светится, гаснет по мере движения
    float d = uv.y - y;
    float crest = exp(-abs(d) * 55.0) * (1.0 - ph * 0.6);
    // Пена — искры на гребне
    float foam = exp(-abs(d) * 90.0) * step(0.86, hash21(floor(uv * vec2(220.0, 90.0))));
    glow += crest + foam * 0.9;
  }

  // Биолюминесцентный цвет: бирюза + акцент
  vec3 lum = mix(vec3(0.2, 0.9, 0.8), u_color, 0.5);
  vec3 col = lum * glow;

  float alpha = glow * u_opacity * u_intensity;
  fragColor = vec4(col, alpha);
}`)

// ══════════════════════════════════════════════════════════════════════
//  18. NETWORK — vertex-based: CPU particles + GL_POINTS + GL_LINES.
//  Точь-в-точь как в чит-меню Rich: 100 частиц дрейфуют по экрану,
//  БЕЛЫЕ точки с Гаусс-свечением, ЛИНИИ (alpha 0.8) только между
//  частицами рядом с мышью. Полное разрешение, нулевая нагрузка на GPU.
// ══════════════════════════════════════════════════════════════════════

// ── Point shaders (gl_POINTS с Гаусс-свечением) ──
const NET_POINT_VERT = `#version 300 es
in vec2 a_pos;    // UV 0-1 (bottom-left origin)
in float a_size;  // pixel diameter
uniform float u_alpha;
out float v_alpha;
void main(){
  gl_Position = vec4(a_pos * 2.0 - 1.0, 0.0, 1.0);
  gl_PointSize = a_size;
  v_alpha = u_alpha;
}`

const NET_POINT_FRAG = `#version 300 es
precision highp float;
in float v_alpha;
uniform vec3 u_color;
out vec4 fragColor;
void main(){
  vec2 c = gl_PointCoord - 0.5;
  float d = length(c) * 2.0;       // 0=центр, 1=край
  float glow = exp(-d * d * 3.0);  // Гаусс (как drawBlurredShadow)
  if (glow < 0.01) discard;
  fragColor = vec4(u_color, glow * v_alpha);
}`

// ── Line shaders (gl_LINES, alpha 0.8) ──
const NET_LINE_VERT = `#version 300 es
in vec2 a_pos;   // UV 0-1
uniform float u_alpha;
out float v_alpha;
void main(){
  gl_Position = vec4(a_pos * 2.0 - 1.0, 0.0, 1.0);
  v_alpha = u_alpha;
}`

const NET_LINE_FRAG = `#version 300 es
precision highp float;
in float v_alpha;
uniform vec3 u_color;
out vec4 fragColor;
void main(){
  fragColor = vec4(u_color, 0.8 * v_alpha);
}`

// ── CPU particle system ──
interface NetParticle {
  x: number       // UV 0-1
  y: number       // UV 0-1
  xSpeed: number  // UV per frame
  ySpeed: number
  size: number    // 0.3-1.6 (как genRandom в референсе)
}

let netParticles: NetParticle[] = []
let netPointProg: WebGLProgram | null = null
let netLineProg: WebGLProgram | null = null
let netPointBuf: WebGLBuffer | null = null
let netLineBuf: WebGLBuffer | null = null
// Float32Array buffers for upload (pre-allocated)
let netPointData: Float32Array = new Float32Array(100 * 3)  // x, y, size per point
let netLineData: Float32Array = new Float32Array(25 * 25 * 4)  // x,y pairs max
let netPointCount = 0
let netLineVerts = 0

function netInitParticles(count: number): void {
  const w = current.origW || 1920
  const h = current.origH || 1080
  netParticles = []
  for (let i = 0; i < count; i++) {
    // xSpeed/ySpeed: 0-4 px/frame (как nextInt(5) в референсе)
    const xs = Math.floor(Math.random() * 5) / w
    const ys = Math.floor(Math.random() * 5) / h
    netParticles.push({
      x: Math.random(),
      y: Math.random(),
      xSpeed: xs,
      ySpeed: ys,
      size: 0.3 + Math.random() * 1.3,  // genRandom()
    })
  }
}

function netUpdateParticles(step = 1): void {
  const spd = current.speed * step
  for (const p of netParticles) {
    p.x += p.xSpeed * spd
    p.y += p.ySpeed * spd
    // Wrap around (как fall() в референсе)
    if (p.x > 1) p.x = 0
    if (p.y > 1) p.y = 0
    if (p.x < 0) p.x = 1
    if (p.y < 0) p.y = 1
  }
}

function netBuildBuffers(): void {
  const count = netParticles.length
  const range = defaultParam('network')
  const mx = current.mouse[0]
  const my = current.mouse[1]
  const mouseActive = mx >= 0 && mx <= 1 && my >= 0 && my <= 1

  // Build point buffer: x, y, size per vertex
  let pi = 0
  for (let i = 0; i < count; i++) {
    const p = netParticles[i]
    netPointData[pi++] = p.x
    netPointData[pi++] = p.y
    // gl_PointSize = (size + 6) * 2 = size*2+12 (как drawBlurredShadow с blurRadius=6)
    netPointData[pi++] = p.size * 2 + 14
  }
  netPointCount = count

  // Build line buffer: pairs of endpoints for near-mouse particles
  let li = 0
  if (mouseActive) {
    // Find particles near mouse (square check, как в референсе)
    const near: number[] = []
    for (let i = 0; i < count; i++) {
      const p = netParticles[i]
      if (Math.abs(p.x - mx) < range && Math.abs(p.y - my) < range) {
        near.push(i)
        if (near.length >= 25) break  // MAX_NEAR
      }
    }
    // Connect pairs within range of each other
    for (let a = 0; a < near.length; a++) {
      for (let b = a + 1; b < near.length; b++) {
        const pa = netParticles[near[a]]
        const pb = netParticles[near[b]]
        if (Math.abs(pa.x - pb.x) < range && Math.abs(pa.y - pb.y) < range) {
          netLineData[li++] = pa.x
          netLineData[li++] = pa.y
          netLineData[li++] = pb.x
          netLineData[li++] = pb.y
        }
      }
    }
  }
  netLineVerts = li / 2  // each line = 2 vertices
}

function netSetup(): boolean {
  if (!gl) return false

  // КЭШ: программы и буферы уже созданы → переиспользуем (netRender
  // перевязывает все буферы/атрибуты каждый кадр, доп. подготовки нет).
  // Раньше каждый enable пересоздавал 2 программы + 2 буфера → утечка.
  if (netPointProg && netLineProg && netPointBuf && netLineBuf) return true

  // Compile point program
  const pv = compile(NET_POINT_VERT, gl.VERTEX_SHADER)
  const pf = compile(NET_POINT_FRAG, gl.FRAGMENT_SHADER)
  if (!pv || !pf) return false
  netPointProg = gl.createProgram()!
  gl.attachShader(netPointProg, pv)
  gl.attachShader(netPointProg, pf)
  gl.linkProgram(netPointProg)
  gl.deleteShader(pv)
  gl.deleteShader(pf)
  if (!gl.getProgramParameter(netPointProg, gl.LINK_STATUS)) {
    console.error('net point link:', gl.getProgramInfoLog(netPointProg))
    return false
  }

  // Compile line program
  const lv = compile(NET_LINE_VERT, gl.VERTEX_SHADER)
  const lf = compile(NET_LINE_FRAG, gl.FRAGMENT_SHADER)
  if (!lv || !lf) return false
  netLineProg = gl.createProgram()!
  gl.attachShader(netLineProg, lv)
  gl.attachShader(netLineProg, lf)
  gl.linkProgram(netLineProg)
  gl.deleteShader(lv)
  gl.deleteShader(lf)
  if (!gl.getProgramParameter(netLineProg, gl.LINK_STATUS)) {
    console.error('net line link:', gl.getProgramInfoLog(netLineProg))
    return false
  }

  // Create buffers
  netPointBuf = gl.createBuffer()
  netLineBuf = gl.createBuffer()

  // Init particles
  const count = Math.round(defaultCount('network'))
  netInitParticles(count)

  return true
}

function netRender(step = 1): void {
  if (!gl || !netPointProg || !netLineProg) return

  netUpdateParticles(step)
  netBuildBuffers()

  const alpha = current.opacity * 0.55  // u_intensity

  // Draw points
  gl.useProgram(netPointProg)
  const pAlphaLoc = gl.getUniformLocation(netPointProg, 'u_alpha')
  const pColorLoc = gl.getUniformLocation(netPointProg, 'u_color')
  gl.uniform1f(pAlphaLoc, alpha)
  gl.uniform3f(pColorLoc, current.color[0], current.color[1], current.color[2])
  gl.bindBuffer(gl.ARRAY_BUFFER, netPointBuf)
  gl.bufferData(gl.ARRAY_BUFFER, netPointData.subarray(0, netPointCount * 3), gl.DYNAMIC_DRAW)
  gl.enableVertexAttribArray(0)
  gl.vertexAttribPointer(0, 2, gl.FLOAT, false, 12, 0)   // x, y (stride 12 = 3 floats)
  gl.enableVertexAttribArray(1)
  gl.vertexAttribPointer(1, 1, gl.FLOAT, false, 12, 8)   // size (offset 8 = 2 floats)
  gl.enable(gl.BLEND)
  gl.blendFunc(gl.SRC_ALPHA, gl.ONE_MINUS_SRC_ALPHA)
  gl.drawArrays(gl.POINTS, 0, netPointCount)

  // Draw lines
  if (netLineVerts > 0) {
    gl.useProgram(netLineProg)
    const lAlphaLoc = gl.getUniformLocation(netLineProg, 'u_alpha')
    const lColorLoc = gl.getUniformLocation(netLineProg, 'u_color')
    gl.uniform1f(lAlphaLoc, alpha)
    gl.uniform3f(lColorLoc, current.color[0], current.color[1], current.color[2])
    gl.bindBuffer(gl.ARRAY_BUFFER, netLineBuf)
    gl.bufferData(gl.ARRAY_BUFFER, netLineData.subarray(0, netLineVerts * 2), gl.DYNAMIC_DRAW)
    gl.enableVertexAttribArray(0)
    gl.vertexAttribPointer(0, 2, gl.FLOAT, false, 0, 0)
    gl.drawArrays(gl.LINES, 0, netLineVerts)
  }
}

// ── Таблица шейдеров ─────────────────────────────────────────────────
const FRAG: Record<string, string> = {
  aurora: AURORA_FRAG,
  silk: SILK_FRAG,
  warp: WARP_FRAG,
  nebula: NEBULA_FRAG,
  plasma: PLASMA_FRAG,
  caustics: CAUSTICS_FRAG,
  vortex: VORTEX_FRAG,
  flow: FLOW_FRAG,
  crystal: CRYSTAL_FRAG,
  magma: MAGMA_FRAG,
  interference: INTERFERENCE_FRAG,
  hexgrid: HEXGRID_FRAG,
  oil: OIL_FRAG,
  solar: SOLAR_FRAG,
  dream: DREAM_FRAG,
  smoke: SMOKE_FRAG,
  tide: TIDE_FRAG,
  // network — vertex-based (GL_POINTS + GL_LINES), не fullscreen fragment shader
}

// ── Uniforms ────────────────────────────────────────────────────────
interface Uniforms {
  u_res?: WebGLUniformLocation | null
  u_time?: WebGLUniformLocation | null
  u_speed?: WebGLUniformLocation | null
  u_opacity?: WebGLUniformLocation | null
  u_color?: WebGLUniformLocation | null
  u_seed?: WebGLUniformLocation | null
  u_intensity?: WebGLUniformLocation | null
  u_param?: WebGLUniformLocation | null
  u_mouse?: WebGLUniformLocation | null
  u_count?: WebGLUniformLocation | null
  u_scale?: WebGLUniformLocation | null
}

interface EffState {
  program: WebGLProgram
  uni: Uniforms
  /** Стиль, под который собрана программа — для кэша в setup(). */
  style: BgStyle
}

let gl: WebGL2RenderingContext | null = null
let state: EffState | null = null
let running = false
const current: {
  style: BgStyle
  color: [number, number, number]
  opacity: number
  speed: number
  params: Record<string, number>
  seed: number
  time: number
  mouse: [number, number]
  origW: number
  origH: number
  renderScale: number
} = { style: 'none', color: [1, 1, 1], opacity: 0.6, speed: 1, params: {}, seed: 0, time: 0, mouse: [-100, -100], origW: 0, origH: 0, renderScale: 1.0 }

function compile(src: string, type: number): WebGLShader | null {
  const sh = gl!.createShader(type as 35633 | 35634)
  gl!.shaderSource(sh, src)
  gl!.compileShader(sh)
  if (!gl!.getShaderParameter(sh, gl!.COMPILE_STATUS)) {
    console.error('Shader compile:', gl!.getShaderInfoLog(sh), src)
    return null
  }
  return sh
}

let VERT_SHADER: WebGLShader | null = null

// Quad-буфер (fullscreen-треугольники) — ОДИН на всё время жизни воркера.
// Раньше setup() создавал новый буфер на каждый вызов → утечка GPU-памяти.
let quadBuf: WebGLBuffer | null = null

/** Перевязать quad-буфер и атрибут a_pos (после network-рендера ARRAY_BUFFER
 *  указывает на буферы частиц — перед fragment-рендером нужно вернуть quad). */
function bindQuad(): void {
  if (!gl || !quadBuf) return
  gl.bindBuffer(gl.ARRAY_BUFFER, quadBuf)
  gl.vertexAttribPointer(0, 2, gl.FLOAT, false, 0, 0)
  gl.enableVertexAttribArray(0)
  gl.disableVertexAttribArray(1)
}

function setup(style: BgStyle): boolean {
  if (!gl) return false
  // network — vertex-based (GL_POINTS + GL_LINES), не fullscreen fragment shader
  if (style === 'network') {
    // Освобождаем программу fragment-стиля, если была
    if (state) { gl.deleteProgram(state.program); state = null }
    return netSetup()
  }
  // КЭШ: тот же стиль уже собран → переиспользуем программу. Раньше каждый
  // enable (а он летит на КАЖДЫЙ разворот окна из трея/свёрнутого —
  // visibilitychange цикл disable→enable) компилировал новый шейдер,
  // создавал новую программу и буфер, не удаляя старые. Утечка накапливалась
  // циклами свернуть/развернуть → деградация рендера вплоть до потери
  // WebGL-контекста (фон «пропадал» или становился ужасным), лечилось
  // только перезапуском. Теперь ресурсы живут один раз.
  if (state && state.style === style) {
    gl.useProgram(state.program)
    bindQuad()
    return true
  }
  // Смена стиля: удаляем программу и буфер предыдущего
  if (state) { gl.deleteProgram(state.program); state = null }
  const fsSrc = FRAG[style]
  if (!fsSrc) return false
  const fs = compile(fsSrc, gl.FRAGMENT_SHADER) as WebGLShader | null
  if (!fs) return false
  const prog = gl.createProgram()!
  gl.attachShader(prog, VERT_SHADER! as WebGLShader)
  gl.attachShader(prog, fs)
  gl.linkProgram(prog)
  // Шейдер после линковки больше не нужен (удалится при deleteProgram)
  gl.deleteShader(fs)
  if (!gl.getProgramParameter(prog, gl.LINK_STATUS)) {
    console.error('link:', gl.getProgramInfoLog(prog))
    gl.deleteProgram(prog)
    return false
  }
  const uni: Uniforms = {}
  for (const name of ['u_res', 'u_time', 'u_speed', 'u_opacity', 'u_color', 'u_seed', 'u_intensity', 'u_param', 'u_mouse', 'u_count', 'u_scale'])
    uni[name as keyof Uniforms] = gl.getUniformLocation(prog, name)
  state = { program: prog, uni, style }
  gl.useProgram(prog)
  if (!quadBuf) quadBuf = gl.createBuffer()
  gl.bindBuffer(gl.ARRAY_BUFFER, quadBuf)
  gl.bufferData(gl.ARRAY_BUFFER, new Float32Array([-1, -1, 1, -1, -1, 1, -1, 1, 1, -1, 1, 1]), gl.STATIC_DRAW)
  gl.vertexAttribPointer(0, 2, gl.FLOAT, false, 0, 0)
  gl.enableVertexAttribArray(0)
  // attrib 1 (размер частиц network) мог остаться включённым после
  // network-рендера — fragment-стили его не используют, выключаем.
  gl.disableVertexAttribArray(1)
  return true
}

// ── Параметры по умолчанию для каждого стиля ─────────────────────────
function defaultParam(style: BgStyle): number {
  const p = current.params
  switch (style) {
    case 'silk': return p['silk.scale'] ?? 4.0
    case 'warp': return p['warp.amount'] ?? 1.5
    case 'nebula': return p['nebula.scale'] ?? 3.0
    case 'plasma': return p['plasma.scale'] ?? 6.0
    case 'caustics': return p['caustics.scale'] ?? 5.0
    case 'vortex': return p['vortex.scale'] ?? 4.0
    case 'flow': return p['flow.scale'] ?? 5.0
    case 'crystal': return p['crystal.scale'] ?? 5.0
    case 'magma': return p['magma.size'] ?? 5.0
    case 'interference': return p['interference.scale'] ?? 10.0
    case 'hexgrid': return p['hexgrid.scale'] ?? 4.0
    case 'oil': return p['oil.scale'] ?? 3.5
    case 'solar': return p['solar.scale'] ?? 4.0
    case 'dream': return p['dream.scale'] ?? 2.0
    case 'smoke': return p['smoke.scale'] ?? 4.0
    case 'tide': return p['tide.waves'] ?? 3.0
    case 'network': return p['network.linkDist'] ?? 0.15
    default: return 1.0 // aurora — без параметра
  }
}

function defaultCount(style: BgStyle): number {
  const p = current.params
  switch (style) {
    case 'network': return p['network.count'] ?? 100.0
    default: return 0.0
  }
}

// ── Render scale per style ──────────────────────────────────────────
// network: 1.0 (vertex-based, полное разрешение, не лагает)
// остальные: 0.35 (noise-эффекты мягкие/размытые — на 0.35× от физических
// пикселей разница неотличима от 0.5×, а площадь текстуры и работа
// GPU-композиции на кадр падают ещё вдвое; было 0.5)
function styleScale(style: BgStyle): number {
  if (style === 'network') return 1.0
  // 0.5 — компромисс чёткость/GPU-нагрузка. 0.35 делал фоны заметно мыльными.
  // На CPU разрешение почти не влияет (пиксели считает GPU), а idle-режим
  // (setTimeout 30fps) уже убрал основную CPU-нагрузку.
  return 0.5
}

function resizeCanvas(): void {
  if (!gl || current.origW <= 0) return
  const rw = Math.max(1, Math.round(current.origW * current.renderScale))
  const rh = Math.max(1, Math.round(current.origH * current.renderScale))
  gl.canvas.width = rw
  gl.canvas.height = rh
  gl.viewport(0, 0, rw, rh)
}

if (typeof onmessage !== 'undefined') {
  let rafId: ReturnType<typeof requestAnimationFrame> | null = null
  let idleTimer: ReturnType<typeof setTimeout> | null = null
  // ── Адаптивный рендер-цикл ─────────────────────────────────────────────
  // 1) rAF останавливается при running=false (раньше перепланировался ДО
  //    проверки → тикал вхолостую на герцовку монитора даже при выкл. фоне).
  // 2) ДВА режима планирования кадров:
  //    - мышь активна (последние 400мс) → rAF с капом 60fps — идеальная
  //      интерактивность, поток просыпается на vsync;
  //    - мышь неактивна → setTimeout-планирование ~30fps — поток СПИТ между
  //      кадрами, а не просыпается на каждый vsync монитора (144 пробуждения
  //      в сек → 30). Для медленных фоновых эффектов 30fps неотличимо.
  // 3) dt-компенсация: время шейдера и шаг частиц масштабируются реальным
  //    dt кадра → скорость анимации НЕ зависит от fps (раньше 0.016/кадр
  //    предполагало ровно 60fps; на 144Hz всё летело в 2.4× быстрее).
  let lastFrameTs = 0
  let lastMouseTs = -1e9
  const IDLE_MOUSE_MS = 400
  const IDLE_FRAME_MS = 33 // ~30 fps cap в простое
  // ~40 fps при движении мыши (было 16 = 60fps). Каждый кадр фона заставляет
  // композитор пересчитывать backdrop-filter на видимых элементах — 40fps
  // вместо 60 снижает эту работу в 1.5 раза, визуально на медленных фонах
  // неотличимо. Плавность интеракции сохраняет dt-компенсация.
  const ACTIVE_FRAME_MS = 25

  /** Мышь-реактивные стили: только им нужен отклик на курсор. Из 17 стилей
   *  u_mouse используют caustics (7-я капля) и interference (4-й источник),
   *  network рисует линии к частицам у курсора. Для остальных стилей
   *  движение мыши вообще не должно менять нагрузку — остаёмся в idle-режиме. */
  function usesMouse(style: BgStyle): boolean {
    return style === 'caustics' || style === 'interference' || style === 'network'
  }

  /** Рендер одного кадра с dt-компенсацией. */
  function renderFrame(now: number): void {
    const dt = lastFrameTs > 0 ? Math.min(now - lastFrameTs, 100) : 16.67
    lastFrameTs = now
    if (current.style === 'network') {
      // Network: vertex-based render (CPU particles + GL_POINTS + GL_LINES)
      gl!.clear(gl!.COLOR_BUFFER_BIT)
      netRender(dt / 16.67)
    } else if (state) {
      // Fullscreen fragment shader
      current.time += (dt / 1000) * Math.max(current.speed, 0.01)
      // Обёртка времени: u_time — float32 в шейдере, на больших значениях
      // (часы работы) sin/fbm теряют точность → анимация дёргается и
      // «деградирует». 7200с (2ч) — с запасом безопасный диапазон;
      // одиночный скачок раз в 2 часа для фонового шума незаметен.
      if (current.time > 7200) current.time = 0
      applyUniforms()
      gl!.clear(gl!.COLOR_BUFFER_BIT)
      gl!.drawArrays(gl!.TRIANGLES, 0, 6)
    }
  }

  function loop(): void {
    if (!gl || !running) { rafId = null; return }
    const now = performance.now()
    // Активный режим — ТОЛЬКО для мышь-реактивных стилей (caustics/
    // interference/network). Для остальных мышь не влияет на картинку,
    // движение курсора не должно поднимать fps.
    const mouseActive = usesMouse(current.style) && now - lastMouseTs < IDLE_MOUSE_MS
    if (mouseActive) {
      // Активная мышь: rAF (vsync-темп) с капом 60fps.
      rafId = requestAnimationFrame(loop)
      if (now - lastFrameTs < ACTIVE_FRAME_MS) return
      renderFrame(now)
    } else {
      // Idle: рендерим кадр и планируем следующий через setTimeout —
      // поток спит между кадрами, а не просыпается на каждый vsync.
      rafId = null
      renderFrame(now)
      idleTimer = setTimeout(loop, IDLE_FRAME_MS)
    }
  }

  /** Перезапуск цикла, если он остановлен (enable/init/setStyle/setMouse). */
  function ensureLoop(): void {
    if (idleTimer !== null) { clearTimeout(idleTimer); idleTimer = null }
    if (rafId === null) {
      lastFrameTs = 0
      rafId = requestAnimationFrame(loop)
    }
  }

  /** Полная остановка обоих планировщиков. */
  function stopLoop(): void {
    if (idleTimer !== null) { clearTimeout(idleTimer); idleTimer = null }
    if (rafId !== null) { cancelAnimationFrame(rafId as number); rafId = null }
  }

  function applyUniforms(): void {
    if (!gl || !state) return
    const u = state.uni
    gl.uniform2f(u.u_res!, gl.canvas.width, gl.canvas.height)
    gl.uniform1f(u.u_time!, current.time)
    gl.uniform1f(u.u_speed!, current.speed)
    gl.uniform1f(u.u_opacity!, current.opacity)
    gl.uniform3f(u.u_color!, current.color[0], current.color[1], current.color[2])
    gl.uniform1f(u.u_seed!, current.seed)
    gl.uniform1f(u.u_intensity!, 0.55)
    gl.uniform1f(u.u_param!, defaultParam(current.style))
    // u_mouse / u_count — null-safe: если шейдер не использует их,
    // getUniformLocation вернёт null и uniform просто не выставится.
    if (u.u_mouse) gl.uniform2f(u.u_mouse, current.mouse[0], current.mouse[1])
    if (u.u_count) gl.uniform1f(u.u_count, defaultCount(current.style))
    if (u.u_scale) gl.uniform1f(u.u_scale, current.renderScale)
  }

  let seedCounter = 1

  onmessage = (e: MessageEvent<BgMessage>) => {
    const m = e.data
    switch (m.type) {
      case 'init': {
        gl = m.canvas.getContext('webgl2', { alpha: true, antialias: false, depth: false, stencil: false, powerPreference: 'high-performance' }) as WebGL2RenderingContext | null
        if (!gl) return
        gl.clearColor(0, 0, 0, 0)
        gl.enable(gl.BLEND)
        gl.blendFunc(gl.SRC_ALPHA, gl.ONE_MINUS_SRC_ALPHA)
        VERT_SHADER = compile(VERT_SRC, gl.VERTEX_SHADER)
        if (!VERT_SHADER) return
        current.style = m.style
        current.color = m.color
        current.opacity = m.opacity
        current.speed = m.speed
        current.params = m.params
        current.seed = m.seed
        current.time = 0
        running = setup(m.style)
        current.origW = m.w
        current.origH = m.h
        current.renderScale = styleScale(m.style)
        resizeCanvas()
        ensureLoop()
        break
      }
      case 'setStyle': {
        if (!gl) break
        current.style = m.style
        current.seed = (++seedCounter * 137.0) % 1000.0
        current.time = 0
        current.renderScale = styleScale(m.style)
        resizeCanvas()
        running = setup(m.style)
        ensureLoop()
        break
      }
      case 'setColor': current.color = m.color; break
      case 'setOpacity': current.opacity = m.opacity; break
      case 'setSpeed': current.speed = m.speed; break
      case 'setParams': {
        current.params = { ...current.params, ...m.params }
        // Если изменилось количество частиц network — реинит
        if (current.style === 'network' && m.params['network.count'] !== undefined) {
          netInitParticles(Math.round(m.params['network.count']))
        }
        break
      }
      case 'resize': {
        if (gl) {
          current.origW = m.w
          current.origH = m.h
          resizeCanvas()
        }
        break
      }
      case 'setMouse': {
        current.mouse = [m.x, m.y]
        lastMouseTs = performance.now()
        // Мышь проснулась → мгновенно выходим из idle-режима (setTimeout → rAF).
        // Только для мышь-реактивных стилей — остальным пробуждение не нужно.
        if (running && rafId === null && usesMouse(current.style)) ensureLoop()
        break
      }
      case 'enable': {
        if (!gl) break
        // Сброс времени при пробуждении: пока окно было скрыто, цикл мог
        // тикать (visibilitychange в Electron прилетает не всегда) и time
        // накопил часы → шейдер рисовал мусор. Плюс свежий старт анимации
        // после разворота окна незаметен для фоновых эффектов.
        current.time = 0
        if (current.style !== 'none') running = setup(current.style)
        ensureLoop()
        break
      }
      case 'disable': {
        running = false
        stopLoop()
        if (gl) gl.clear(gl.COLOR_BUFFER_BIT)
        break
      }
      case 'destroy': {
        running = false
        stopLoop()
        break
      }
    }
  }
}
