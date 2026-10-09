// ==UserScript==
// @name         Twitterentary Shaders
// @namespace    tweetcraft.twitterentary
// @version      1.1.0
// @author       andrestube123
// @description  Complementary-inspired shaders for TweetCraft: real sun shadows (shadow map), sun lighting, waving leaves and plants, reflective water, improved sky and clouds. Press K to toggle. v1.1: much cheaper shadows.
// @match        https://tweetcraft.jai.vin/*
// @run-at       document-start
// @grant        none
// ==/UserScript==

(() => {
    'use strict';

    const TAG = '[Twitterentary]';

    // =====================================================================
    //  CONFIG  ("baked" values need a page reload to take effect)
    //  At runtime: press K to toggle all shaders, or use the console:
    //  Twitterentary.cfg.shadows = false
    // =====================================================================
    const CFG = {
        enabled: true,          // master switch (toggle with K)
        shadows: true,          // sun shadows (runtime)
        shadowSize: 2048,       // shadow map resolution: 1024 / 2048 / 4096 (baked)
        shadowExtent: 56,       // radius (in blocks) around the player that receives shadows (baked)
        shadowDepth: 256,       // light depth range (baked)

        shadowEvery: 8,         // v1.1: regenerate the shadow map at most every N frames (runtime)
        shadowMove: 6,          // v1.1: ...or when the camera moves more than N blocks (runtime)
        shadowTaps: 8,          // v1.1: PCF samples, 4 = faster (baked)

        waving: true,           // leaf and plant movement (baked)
        leafSway: 0.028,
        plantSway: 0.075,

        waterEffects: true,     // reflections, fresnel, sun glint, waves
        waveStrength: 1.0,

        skyEffects: true,       // sky scattering, sun halo, haze
        cloudEffects: true,     // clouds tinted at sunset

        sunStrength: 0.90,      // direct light intensity
        ambientStrength: 1.0,   // ambient (sky) light intensity
        blockLight: 1.0,        // torch / block light intensity
        aoPower: 1.5,           // corner darkness (contact shadows)
        exposure: 1.0,
        saturation: 1.12,
        contrast: 1.05,
        emissive: 1.15          // minimum brightness of lava, glowstone, etc.
    };

    const proto = window.WebGL2RenderingContext && WebGL2RenderingContext.prototype;
    if (!proto) return;

    const O = {};
    for (const k of ['shaderSource', 'compileShader', 'attachShader', 'linkProgram', 'useProgram',
        'bindVertexArray', 'deleteVertexArray', 'getUniformLocation', 'uniform3f', 'drawElements', 'clear']) {
        O[k] = proto[k];
    }

    // ---------------------------------------------------------------------
    //  math helpers
    // ---------------------------------------------------------------------
    const clamp01 = x => Math.min(1, Math.max(0, x));
    const sstep = (a, b, x) => { const t = clamp01((x - a) / (b - a)); return t * t * (3 - 2 * t); };
    const mixv = (a, b, t) => a.map((v, i) => v + (b[i] - v) * t);
    const norm = v => { const l = Math.hypot(v[0], v[1], v[2]) || 1; return [v[0] / l, v[1] / l, v[2] / l]; };
    const cross = (a, b) => [a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]];
    const dot = (a, b) => a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
    const F = n => Number(n).toFixed(4);

    // =====================================================================
    //  GLSL
    // =====================================================================

    // ---------- VERTEX: terrain ----------
    function patchTerrainVS(src) {
        const re = /vec3\s+p\s*=\s*vec3\(\s*aPos\s*&\s*uvec3\(\s*0x1FFu\s*,\s*0xFFFu\s*,\s*0x1FFu\s*\)\s*\)\s*\*\s*0\.0625\s*\+\s*uOrigin\s*;/;
        if (!/aPos\s*&\s*uvec3/.test(src) || !src.includes('uniform vec3 uOrigin;') ||
            !re.test(src) || !src.includes('out vec2 vLight;')) return null;

        let s = src.replace('uniform vec3 uOrigin;', () =>
            'uniform vec3 uOrigin;\nuniform highp sampler2D uClsTex;\nuniform vec3 uCam;\nuniform float uTime;\nuniform float uFx;');
        s = s.replace('out vec2 vLight;', () => 'out vec2 vLight;\nout vec3 vRel;\nflat out float vCls;');

        const wave = CFG.waving ? `
  if (uFx > 0.5 && tcC > 0.5 && tcC < 2.5) {
    vec3 tcW = p + uCam;
    float tcPl = tcC > 1.5 ? 1.0 : 0.0;
    // plants: the base (v=1) stays fixed, the tip moves
    float tcWt = tcPl > 0.5 ? 1.0 - float((aInfo.y >> 1u) & 1u) : 1.0;
    float tcG = 0.55 + 0.9 * (0.5 + 0.5 * sin(tcW.x * 0.11 + tcW.z * 0.07 + uTime * 0.45));
    float tcA = sin(uTime * 1.7 + tcW.x * 1.30 + tcW.z * 0.90) + 0.5 * sin(uTime * 3.1 + tcW.x * 2.30 - tcW.z * 1.70);
    float tcB = sin(uTime * 1.4 + tcW.z * 1.20 - tcW.x * 0.70) + 0.5 * sin(uTime * 2.7 - tcW.z * 2.10 + tcW.x * 1.90);
    float tcAmp = mix(${F(CFG.leafSway)}, ${F(CFG.plantSway)}, tcPl) * tcWt * tcG;
    p.x += tcA * tcAmp;
    p.z += tcB * tcAmp;
    p.y += tcPl > 0.5 ? -abs(tcA + tcB) * tcAmp * 0.2 : tcB * tcAmp * 0.3;
  }` : '';

        return s.replace(re, m => `${m}
  vRel = p;
  float tcC = floor(texelFetch(uClsTex, ivec2(int(aInfo.x), 0), 0).r * 255.0 + 0.5);
  vCls = tcC;${wave}`);
    }

    // ---------- FRAGMENT: terrain ----------
    function fsDecls(lit) {
        const SZ = F(CFG.shadowSize), Z = F(CFG.shadowDepth);
        const texel = F(2 * CFG.shadowExtent / CFG.shadowSize);
        const TAPS = Math.max(2, Math.round(Number(CFG.shadowTaps) || 8));
        return `
uniform vec3 uCam;
uniform float uTime;
uniform vec3 uSunDir;
uniform vec3 uSunCol;
uniform vec3 uZenith;
uniform vec3 uSkySun;
uniform float uDay;
uniform float uDim;
uniform float uShadowOn;
uniform float uFx;
uniform mat4 uLVP;
uniform highp sampler2DShadow uShadowMap;
in vec3 vRel;
flat in float vCls;

vec3 tcTone(vec3 x) {
  vec3 k = max(x - 0.7, 0.0);
  return min(x, vec3(0.7)) + 0.3 * (1.0 - exp(-k / 0.3));
}

vec2 tcWv(vec2 q, vec2 d, float k, float a, float s) {
  return d * (k * a) * cos(dot(q, d) * k + uTime * s);
}
vec2 tcWaveSlope(vec2 q) {
  vec2 g = tcWv(q, vec2(0.894, 0.447), 1.9, 0.040, 1.2);
  g += tcWv(q, vec2(-0.6, 0.8), 3.1, 0.026, 1.6);
  g += tcWv(q, vec2(0.3, -0.954), 5.3, 0.016, 2.1);
  g += tcWv(q, vec2(-0.95, -0.3), 8.9, 0.009, 2.9);
  return g * ${F(CFG.waveStrength)};
}

float tcShadow(vec3 rel, vec3 n, float ndl) {
  vec3 pos = rel + n * (${texel} * 1.6 + 0.015);
  vec3 sc = (uLVP * vec4(pos, 1.0)).xyz * 0.5 + 0.5;
  float edge = max(abs(sc.x - 0.5), abs(sc.y - 0.5)) * 2.0;
  if (edge >= 1.0 || sc.z >= 1.0 || sc.z <= 0.0) return 1.0;
  sc.z -= (0.03 + 0.06 * (1.0 - ndl)) / (2.0 * ${Z});
  float ign = fract(52.9829189 * fract(dot(gl_FragCoord.xy, vec2(0.06711056, 0.00583715))));
  float ang = ign * 6.2831853;
  float inv = 1.0 / ${SZ};
  float s = 0.0;
  for (int i = 0; i < ${TAPS}; i++) {
    float r = sqrt((float(i) + 0.5) / ${TAPS}.0) * 1.5;
    float a = float(i) * 2.3999632 + ang;
    s += texture(uShadowMap, vec3(sc.xy + vec2(cos(a), sin(a)) * r * inv, sc.z));
  }
  s *= ${F(1 / TAPS)};
  return mix(1.0, s, 1.0 - smoothstep(0.82, 1.0, edge));
}
`;
    }

    function shadeCode(lit, alpha) {
        const vanilla = `
  if (uFx < 0.5) { o = vec4(mix(c.rgb * vShade${lit ? ' * lightmap(vLight)' : ''}, uFog, f), ${alpha}); return; }
`;
        const water = CFG.waterEffects ? `
  if (tcWater) {
    vec3 tcWp = vRel + uCam;
    vec2 tcG = tcWaveSlope(tcWp.xz);
    float tcTopW = smoothstep(0.75, 0.95, tcN.y);
    vec3 tcWn = normalize(mix(tcN, normalize(vec3(-tcG.x, 1.0, -tcG.y)), tcTopW));
    vec3 tcVv = -tcV;
    float tcFres = 0.03 + 0.97 * pow(1.0 - clamp(dot(tcWn, tcVv), 0.0, 1.0), 5.0);
    vec3 tcR = reflect(tcV, tcWn);
    vec3 tcRefl = mix(uFog, uZenith, pow(max(tcR.y, 0.0), 0.5));
    float tcSd = max(dot(tcR, uSkySun), 0.0);
    vec3 tcSpec = uSunCol * (pow(tcSd, 600.0) * 6.0 + pow(tcSd, 40.0) * 0.25)
                * tcDay * smoothstep(0.0, 0.1, uSkySun.y) * tcSky;
    float tcMd = max(dot(tcR, -uSkySun), 0.0);
    tcSpec += vec3(0.6, 0.7, 1.0) * pow(tcMd, 500.0) * 2.0 * (1.0 - tcDay) * tcSky;
    vec3 tcWB = c.rgb * (tcAmbient * tcAO + tcBlock) * vec3(0.80, 0.95, 1.10) + c.rgb * tcSunL * 0.25;
    tcCol = mix(tcWB, tcRefl * (0.45 + 0.55 * tcSkyK), tcFres * 0.9);
    tcCol += tcSpec * tcTopW;
    tcAlpha = clamp(tcAlpha + tcFres * 0.55, 0.0, 1.0);
  }` : '';

        const blockEngine = lit
            ? '+ max(lightmap(vec2(0.0, vLight.y)) - lightmap(vec2(0.0)), 0.0) * 0.35'
            : '';
        const ambFloor = lit ? '+ vec3(0.012 + uAmbient * 0.5)' : '+ vec3(0.012)';

        return vanilla + `
  vec3 tcNr = cross(tcDx, tcDy);
  float tcNl = length(tcNr);
  vec3 tcN = tcNl > 1e-12 ? tcNr / tcNl : vec3(0.0, 1.0, 0.0);
  vec3 tcV = normalize(vRel);
  bool tcLeaf = vCls > 0.5 && vCls < 1.5;
  bool tcPlant = vCls > 1.5 && vCls < 2.5;
  bool tcWater = vCls > 2.5 && vCls < 3.5;
  bool tcEmit = vCls > 3.5;

  vec3 tcNs = tcN;
  if (tcPlant) tcNs = normalize(mix(tcN, vec3(0.0, 1.0, 0.0), 0.7));
  else if (tcLeaf) tcNs = normalize(mix(tcN, vec3(0.0, 1.0, 0.0), 0.35));

  // ambient occlusion: separated from the engine's per-face shading
  float tcExp = abs(tcN.y) > 0.5 ? (tcN.y > 0.0 ? 1.0 : 0.5) : (abs(tcN.x) > abs(tcN.z) ? 0.6 : 0.8);
  float tcAO = pow(clamp(vShade / tcExp, 0.0, 1.0), ${F(CFG.aoPower)});

  float tcSky = ${lit ? 'clamp(vLight.x * (1.0 / 15.0), 0.0, 1.0)' : '1.0'};
  float tcBl = ${lit ? 'clamp(vLight.y * (1.0 / 15.0), 0.0, 1.0)' : '0.0'};
  float tcDay = uDay;
  float tcHemi = tcNs.y * 0.5 + 0.5;

  // hemispheric ambient light
  vec3 tcAmbDay = mix(vec3(0.40, 0.37, 0.32), vec3(0.50, 0.60, 0.80), tcHemi);
  float tcTw = tcDay * (1.0 - tcDay) * 4.0;
  tcAmbDay = mix(tcAmbDay, tcAmbDay * vec3(1.25, 0.95, 0.80), tcTw * 0.5);
  vec3 tcAmbNight = mix(vec3(0.05, 0.065, 0.11), vec3(0.09, 0.12, 0.22), tcHemi);
  vec3 tcAmb = mix(tcAmbNight, tcAmbDay, tcDay);
  float tcSkyK = pow(tcSky, 1.7);
  if (uDim > 1.5) { tcAmb = mix(vec3(0.10, 0.08, 0.13), vec3(0.16, 0.13, 0.19), tcHemi); tcSkyK = 1.0; }
  else if (uDim > 0.5) { tcAmb = mix(vec3(0.24, 0.10, 0.07), vec3(0.34, 0.16, 0.10), tcHemi); tcSkyK = 1.0; }
  vec3 tcAmbient = tcAmb * ${F(CFG.ambientStrength)} * (0.14 + 0.86 * tcSkyK) ${ambFloor};

  // block light (torches, lava...)
  vec3 tcBlock = (vec3(1.0, 0.60, 0.30) * pow(tcBl, 2.2) * 1.5 ${blockEngine}) * ${F(CFG.blockLight)};

  // sun + shadows (the shadow is only sampled where the sun can actually reach)
  float tcNdl = clamp(dot(tcNs, uSunDir) * 1.1 + 0.06, 0.0, 1.0);
  float tcSunMask = tcDay * smoothstep(0.0, 0.15, uSkySun.y) * smoothstep(0.5, 0.95, tcSky);
  if (uDim > 0.5) tcSunMask = 0.0;
  float tcVis = 1.0;
  if (uShadowOn > 0.5 && tcNdl > 0.001 && tcSunMask > 0.001) tcVis = tcShadow(vRel, tcN, tcNdl);
  vec3 tcSunL = uSunCol * (tcNdl * tcVis * tcSunMask * ${F(CFG.sunStrength)});
  if (tcLeaf) {
    float tcBack = pow(clamp(dot(tcV, uSunDir), 0.0, 1.0), 3.0);
    tcSunL += c.rgb * uSunCol * tcBack * tcVis * tcSunMask * 0.5;
  }

  vec3 tcLight = tcAmbient * tcAO + tcBlock * (0.6 + 0.4 * tcAO) + tcSunL * (0.55 + 0.45 * tcAO);
  vec3 tcCol = c.rgb * tcLight;
  if (tcEmit) tcCol = max(tcCol, c.rgb * ${F(CFG.emissive)});
  float tcAlpha = ${alpha};
  ${water}

  // color grading
  tcCol *= ${F(CFG.exposure)};
  tcCol = tcTone(tcCol);
  float tcLum = dot(tcCol, vec3(0.299, 0.587, 0.114));
  tcCol = mix(vec3(tcLum), tcCol, ${F(CFG.saturation)});
  tcCol = clamp((tcCol - 0.5) * ${F(CFG.contrast)} + 0.5, 0.0, 1.0);

  // atmospheric fog with scattering toward the sun
  float tcF = f * f * (3.0 - 2.0 * f);
  vec3 tcFog = uFog + uSunCol * pow(max(dot(tcV, uSkySun), 0.0), 6.0) * 0.18 * tcDay * tcF;
  o = vec4(mix(tcCol, tcFog, tcF), tcAlpha);
`;
    }

    function patchTerrainFS(src) {
        const outRe = /o\s*=\s*vec4\(\s*mix\(\s*c\.rgb\s*\*\s*vShade(\s*\*\s*lightmap\(\s*vLight\s*\))?\s*,\s*uFog\s*,\s*f\s*\)\s*,\s*([^;]*?)\s*\)\s*;/;
        const cRe = /vec4\s+c\s*=\s*texture\(\s*uTex\s*,\s*vUV\s*\)\s*;/;
        const mainRe = /void\s+main\s*\(\s*\)\s*\{/;
        const m = outRe.exec(src);
        if (!m || !cRe.test(src) || !mainRe.test(src)) return null;
        const lit = !!m[1];
        const alpha = m[2].trim();
        const mode = alpha === 'c.a' ? 2 : (/discard/.test(src) ? 1 : 0);

        let s = src.replace(mainRe, mm => fsDecls(lit) + '\n' + mm);
        s = s.replace(cRe, mm => `${mm}\n  vec3 tcDx = dFdx(vRel), tcDy = dFdy(vRel);`);
        s = s.replace(outRe, () => shadeCode(lit, alpha));
        return { src: s, info: { terrainFS: true, mode, lit } };
    }

    // ---------- sky ----------
    function skyCode() {
        return `
  if (uFx < 0.5) { o = vec4(tcBase, 1.0); return; }
  vec3 tcd = normalize(vDir);
  float tcH = clamp(tcd.y, 0.0, 1.0);
  float tcSD = uSkyDay;
  float tcSunY = uSkySun.y;
  vec3 tcC = tcBase;
  float tcLum = dot(tcC, vec3(0.299, 0.587, 0.114));
  tcC = mix(vec3(tcLum), tcC, 1.0 + 0.30 * tcSD);
  tcC *= 1.0 - 0.14 * tcSD * smoothstep(0.15, 1.0, tcH);
  float tcHz = pow(1.0 - tcH, 4.0);
  tcC += vec3(0.07, 0.085, 0.10) * tcHz * tcSD;
  float tcSd = max(dot(tcd, uSkySun), 0.0);
  vec3 tcSc = mix(vec3(1.0, 0.50, 0.22), vec3(1.0, 0.90, 0.72), smoothstep(0.0, 0.4, tcSunY));
  float tcVis = smoothstep(-0.25, 0.08, tcSunY);
  tcC += tcSc * (pow(tcSd, 5.0) * 0.16 + pow(tcSd, 40.0) * 0.30 + pow(tcSd, 700.0) * 0.6) * tcVis;
  float tcMd = max(dot(tcd, -uSkySun), 0.0);
  tcC += vec3(0.45, 0.55, 0.90) * (pow(tcMd, 80.0) * 0.12 + pow(tcMd, 2000.0) * 0.3) * (1.0 - tcSD);
  tcC += (fract(sin(dot(gl_FragCoord.xy, vec2(12.9898, 78.233))) * 43758.5453) - 0.5) / 255.0;
  o = vec4(tcC, 1.0);
`;
    }

    function patchSky(src) {
        if (!CFG.skyEffects) return null;
        if (!/uniform\s+vec3\s+uTop\s*,\s*uHor\s*;/.test(src) || !src.includes('vDir')) return null;
        const litRe = /o\s*=\s*vec4\(\s*c\s*,\s*1\.0\s*\)\s*;/;
        const plainRe = /o\s*=\s*vec4\(\s*mix\(\s*uHor\s*,\s*uTop\s*,\s*sqrt\(\s*t\s*\)\s*\)\s*,\s*1\.0\s*\)\s*;/;
        let s = src.replace(/out\s+vec4\s+o\s*;/, mm => mm + '\nuniform vec3 uSkySun;\nuniform float uSkyDay;\nuniform float uFx;');
        if (!s.includes('uSkySun')) return null;
        if (litRe.test(s)) s = s.replace(litRe, () => 'vec3 tcBase = c;\n' + skyCode());
        else if (plainRe.test(s)) s = s.replace(plainRe, () => 'vec3 tcBase = mix(uHor, uTop, sqrt(t));\n' + skyCode());
        else return null;
        return { src: s, info: { sky: true } };
    }

    // ---------- clouds ----------
    function patchCloud(src) {
        if (!CFG.cloudEffects) return null;
        const re = /if\s*\(\s*c\.a\s*<\s*0\.02\s*\)\s*discard\s*;/;
        if (!src.includes('uniform vec4 uTint, uHole;') || !src.includes('uKind') || !re.test(src)) return null;
        let s = src.replace(/uniform\s+int\s+uKind\s*;/, mm => mm + '\nuniform vec3 uCloudTint;\nuniform float uFx;');
        s = s.replace(re, mm => `${mm}
  if (uKind == 1 && uFx > 0.5) { c.rgb *= uCloudTint; c.rgb *= mix(0.88, 1.04, c.a); }`);
        return { src: s, info: { cloud: true } };
    }

    function patchSource(src) {
        if (!src.includes('#version 300 es')) return null;
        if (/aPos\s*&\s*uvec3/.test(src)) {
            const s = patchTerrainVS(src);
            return s ? { src: s, info: { terrainVS: true } } : null;
        }
        if (src.includes('sampler2DArray') && /vShade/.test(src) && /uFog/.test(src) && /vDist/.test(src)) {
            return patchTerrainFS(src);
        }
        if (/uniform\s+vec3\s+uTop\s*,\s*uHor\s*;/.test(src)) return patchSky(src);
        if (src.includes('uTint, uHole')) return patchCloud(src);
        return null;
    }

    // =====================================================================
    //  WebGL hooks
    // =====================================================================
    const shaderSrc = new WeakMap();   // shader -> {orig, patched, info}
    const progShaders = new WeakMap(); // program -> [shaders]
    const progInfo = new WeakMap();    // program -> info
    const originLocs = new WeakSet();  // uOrigin uniform locations (terrain)

    let curInfo = null, curVAO = null, frameId = 0, shadowFrame = -1;
    const lastOrigin = [0, 0, 0];
    let haveOrigin = false;
    const rec = new Map(); // vao -> {n, wx, wy, wz, cut, seen}

    const UNIFORMS = ['uTime', 'uCam', 'uSunDir', 'uSunCol', 'uZenith', 'uSkySun', 'uDay', 'uDim',
        'uFx', 'uShadowOn', 'uLVP', 'uShadowMap', 'uClsTex', 'uSkyDay', 'uCloudTint'];

    proto.shaderSource = function (shader, source) {
        if (typeof source !== 'string') return O.shaderSource.call(this, shader, source);
        let out = source, info = null;
        try {
            const r = patchSource(source);
            if (r) { out = r.src; info = r.info; }
        } catch (e) {
            console.error(TAG, 'Shader patch error:', e);
        }
        shaderSrc.set(shader, { orig: source, info, patched: out !== source });
        return O.shaderSource.call(this, shader, out);
    };

    // If a patched shader fails to compile, fall back to the original (the game keeps working)
    proto.compileShader = function (shader) {
        O.compileShader.call(this, shader);
        const d = shaderSrc.get(shader);
        if (d && d.patched && !this.getShaderParameter(shader, this.COMPILE_STATUS)) {
            console.error(TAG, 'Patched shader failed to compile, using the original:\n' + this.getShaderInfoLog(shader));
            O.shaderSource.call(this, shader, d.orig);
            O.compileShader.call(this, shader);
            d.patched = false; d.info = null;
        }
    };

    proto.attachShader = function (p, s) {
        let list = progShaders.get(p);
        if (!list) { list = []; progShaders.set(p, list); }
        list.push(s);
        return O.attachShader.call(this, p, s);
    };

    proto.linkProgram = function (p) {
        O.linkProgram.call(this, p);
        const list = progShaders.get(p) || [];
        if (!list.some(s => shaderSrc.get(s)?.patched)) return;
        if (this.getProgramParameter(p, this.LINK_STATUS)) {
            const info = { prog: p, loc: null, mode: 0, lit: false };
            for (const s of list) { const d = shaderSrc.get(s); if (d && d.patched && d.info) Object.assign(info, d.info); }
            info.terrain = !!(info.terrainVS && info.terrainFS);
            progInfo.set(p, info);
            const kind = info.terrain ? 'terrain (mode ' + info.mode + (info.lit ? ', lit' : '') + ')' : info.sky ? 'sky' : info.cloud ? 'clouds' : 'partial';
            console.info(TAG, 'Patched program:', kind);
            return;
        }
        console.error(TAG, 'Patched program failed to link, reverting to the original:\n' + this.getProgramInfoLog(p));
        for (const s of list) {
            const d = shaderSrc.get(s);
            if (d && d.patched) {
                O.shaderSource.call(this, s, d.orig);
                O.compileShader.call(this, s);
                d.patched = false; d.info = null;
            }
        }
        O.linkProgram.call(this, p);
    };

    proto.getUniformLocation = function (p, name) {
        const r = O.getUniformLocation.call(this, p, name);
        if (r && name === 'uOrigin') originLocs.add(r);
        return r;
    };

    proto.uniform3f = function (loc, x, y, z) {
        if (originLocs.has(loc)) { lastOrigin[0] = x; lastOrigin[1] = y; lastOrigin[2] = z; haveOrigin = true; }
        return O.uniform3f.call(this, loc, x, y, z);
    };

    proto.bindVertexArray = function (v) { curVAO = v; return O.bindVertexArray.call(this, v); };
    proto.deleteVertexArray = function (v) { rec.delete(v); return O.deleteVertexArray.call(this, v); };
    proto.clear = function (mask) { if (mask & 0x4000) frameId++; return O.clear.call(this, mask); };

    // =====================================================================
    //  Own GL resources + shadow-map bookkeeping
    //  G.sh describes the shadow map that is currently stored in the depth
    //  texture: world-anchored (c0 = camera at the last refresh) and static
    //  until the next refresh.
    // =====================================================================
    const G = {
        init: false, clsTex: null, clsDone: false, clsTry: 0, shadowOk: false, fbo: null, depthTex: null, prog: null, loc: null,
        sh: { valid: false, drawn: true, frame: -999, c0: [0, 0, 0], L: [0, 1, 0], R: [1, 0, 0], U: [0, 0, 1], dx: 0, dy: 0 }
    };

    // Light matrix for the shadow map described by G.sh, expressed relative to the position `at`
    // (the position the vertex shader's "vRel" is relative to).
    function lightMat(m, at) {
        const SH = G.sh, E = CFG.shadowExtent, Zd = CFG.shadowDepth, R = SH.R, U = SH.U, L = SH.L;
        const d = [at[0] - SH.c0[0], at[1] - SH.c0[1], at[2] - SH.c0[2]];
        m[0] = R[0] / E; m[1] = U[0] / E; m[2] = -L[0] / Zd; m[3] = 0;
        m[4] = R[1] / E; m[5] = U[1] / E; m[6] = -L[1] / Zd; m[7] = 0;
        m[8] = R[2] / E; m[9] = U[2] / E; m[10] = -L[2] / Zd; m[11] = 0;
        m[12] = (dot(d, R) + SH.dx) / E; m[13] = (dot(d, U) + SH.dy) / E; m[14] = -dot(d, L) / Zd; m[15] = 1;
        return m;
    }

    // =====================================================================
    //  Per-frame state (sun, sky, light matrix)
    // =====================================================================
    const ST = {
        frame: -1, time: 0, cam: [0, 0, 0], sun: [0, 1, 0], sunL: [0, 1, 0], sunCol: [1, 1, 1],
        zenith: [0.47, 0.655, 1], cloud: [1, 1, 1], day: 1, dim: 0, shadowOn: 0, refresh: false,
        lvp: new Float32Array(16)
    };
    const STATS = { shadowChunks: 0, refreshes: 0 };
    const FIXED_SUN = norm([0.62, 0.6, -0.5]);
    const SCRATCH = new Float32Array(16);

    function updateState() {
        if (ST.frame === frameId) return ST;
        ST.frame = frameId;
        const mc = window.__mc, S = mc && mc.S;
        ST.time = performance.now() / 1000;
        ST.cam = (S && S.cam) ? S.cam : [0, 0, 0];
        const dimName = S && S.sv && S.sv.dim;
        ST.dim = dimName === 'nether' ? 1 : dimName === 'end' ? 2 : 0;

        let sun, day = 1;
        if (S && S.lit && typeof S.time === 'number') {
            const g = ((S.time / 24000 - 0.25) % 1 + 1) % 1;
            const ang = g + ((1 - Math.cos(g * Math.PI)) / 2 - g) / 3;
            const c = Math.cos(ang * 2 * Math.PI), s = Math.sin(ang * 2 * Math.PI);
            sun = [-s, c, 0];
            day = clamp01(c * 2 + 0.5);
        } else {
            sun = FIXED_SUN;
        }
        if (ST.dim) day = 0;
        ST.sun = sun; ST.day = day;
        ST.sunL = norm([sun[0], Math.max(sun[1], 0.14), sun[2]]);

        const h = sun[1], t = sstep(0, 0.35, h);
        ST.sunCol = mixv([1.0, 0.50, 0.24], [1.0, 0.95, 0.84], t);
        const tw = (1 - sstep(0.02, 0.45, h)) * day;
        ST.cloud = mixv([1, 1, 1], [1.0, 0.68, 0.50], tw);
        const env = mc && mc.gfx && mc.gfx.env;
        ST.zenith = (env && env.sky) ? [env.sky[0], env.sky[1], env.sky[2]] : [0.47, 0.655, 1];

        // shadow map: world-anchored, static between refreshes
        const SH = G.sh, E = CFG.shadowExtent, texel = 2 * E / CFG.shadowSize;
        const cam = ST.cam;
        ST.shadowOn = (CFG.enabled && CFG.shadows && G.shadowOk && ST.dim === 0 && sun[1] > 0.06 && day > 0.1) ? 1 : 0;
        if (!ST.shadowOn) { SH.valid = false; ST.refresh = false; return ST; }
        // if the last refresh was never rendered (no terrain draw that frame), force another one
        if (SH.valid && !SH.drawn) SH.valid = false;
        const L = ST.sunL;
        ST.refresh = !SH.valid || frameId - SH.frame >= CFG.shadowEvery
            || Math.hypot(cam[0] - SH.c0[0], cam[1] - SH.c0[1], cam[2] - SH.c0[2]) > CFG.shadowMove
            || dot(L, SH.L) < 0.99995;
        if (ST.refresh) {
            const R = norm(cross(L, [0, 0, 1])), U = cross(L, R);
            const cr = dot(cam, R), cu = dot(cam, U);
            SH.L = L.slice(); SH.R = R; SH.U = U; SH.c0 = cam.slice();
            SH.dx = cr - Math.floor(cr / texel) * texel;
            SH.dy = cu - Math.floor(cu / texel) * texel;
            SH.frame = frameId; SH.valid = true; SH.drawn = false;
        }
        lightMat(ST.lvp, cam);   // matrix for the main pass, relative to the current camera
        return ST;
    }

    // =====================================================================
    //  Own GL resources: class texture, shadow map, shadow program
    // =====================================================================
    function makeProg(gl, vs, fs) {
        const mk = (type, src) => {
            const s = gl.createShader(type);
            O.shaderSource.call(gl, s, src);
            O.compileShader.call(gl, s);
            if (!gl.getShaderParameter(s, gl.COMPILE_STATUS)) throw new Error(gl.getShaderInfoLog(s));
            return s;
        };
        const p = gl.createProgram();
        O.attachShader.call(gl, p, mk(gl.VERTEX_SHADER, vs));
        O.attachShader.call(gl, p, mk(gl.FRAGMENT_SHADER, fs));
        O.linkProgram.call(gl, p);
        if (!gl.getProgramParameter(p, gl.LINK_STATUS)) throw new Error(gl.getProgramInfoLog(p));
        return p;
    }

    const SHADOW_VS = `#version 300 es
precision highp float;
precision highp int;
layout(location=0) in uvec3 aPos;
layout(location=1) in uvec2 aInfo;
uniform mat4 uLVP;
uniform vec3 uOrigin;
uniform highp sampler2D uClsTex;
out vec3 vUV;
void main() {
  float c = floor(texelFetch(uClsTex, ivec2(int(aInfo.x), 0), 0).r * 255.0 + 0.5);
  vUV = vec3(float(aInfo.y & 1u), float((aInfo.y >> 1u) & 1u), float(aInfo.x));
  if (c > 1.5 && c < 3.5) { gl_Position = vec4(2.0, 2.0, 2.0, 1.0); return; }
  vec3 p = vec3(aPos & uvec3(0x1FFu, 0xFFFu, 0x1FFu)) * 0.0625 + uOrigin;
  gl_Position = uLVP * vec4(p, 1.0);
}`;
    const SHADOW_FS = `#version 300 es
precision highp float;
precision highp sampler2DArray;
uniform sampler2DArray uTex;
uniform float uCut;
in vec3 vUV;
void main() {
  if (uCut > 0.5 && textureLod(uTex, vUV, 0.0).a < 0.5) discard;
}`;

    function initGL(gl) {
        if (G.init) return;
        G.init = true;
        const prevActive = gl.getParameter(gl.ACTIVE_TEXTURE);
        const prevProg = gl.getParameter(gl.CURRENT_PROGRAM);
        try {
            // per-layer class texture (unit 7)
            gl.activeTexture(gl.TEXTURE7);
            G.clsTex = gl.createTexture();
            gl.bindTexture(gl.TEXTURE_2D, G.clsTex);
            gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA8, 1024, 1, 0, gl.RGBA, gl.UNSIGNED_BYTE, new Uint8Array(1024 * 4));
            gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.NEAREST);
            gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.NEAREST);
            gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
            gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);

            if (CFG.shadows) {
                const size = CFG.shadowSize;
                gl.activeTexture(gl.TEXTURE6);
                G.depthTex = gl.createTexture();
                gl.bindTexture(gl.TEXTURE_2D, G.depthTex);
                gl.texImage2D(gl.TEXTURE_2D, 0, gl.DEPTH_COMPONENT24, size, size, 0, gl.DEPTH_COMPONENT, gl.UNSIGNED_INT, null);
                gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR);
                gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR);
                gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
                gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
                gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_COMPARE_MODE, gl.COMPARE_REF_TO_TEXTURE);
                gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_COMPARE_FUNC, gl.LEQUAL);

                const prevFB = gl.getParameter(gl.FRAMEBUFFER_BINDING);
                G.fbo = gl.createFramebuffer();
                gl.bindFramebuffer(gl.FRAMEBUFFER, G.fbo);
                gl.framebufferTexture2D(gl.FRAMEBUFFER, gl.DEPTH_ATTACHMENT, gl.TEXTURE_2D, G.depthTex, 0);
                gl.drawBuffers([gl.NONE]);
                gl.readBuffer(gl.NONE);
                const status = gl.checkFramebufferStatus(gl.FRAMEBUFFER);
                gl.bindFramebuffer(gl.FRAMEBUFFER, prevFB);
                if (status !== gl.FRAMEBUFFER_COMPLETE) throw new Error('Shadow framebuffer incomplete: ' + status);

                G.prog = makeProg(gl, SHADOW_VS, SHADOW_FS);
                G.loc = {};
                for (const n of ['uLVP', 'uOrigin', 'uClsTex', 'uTex', 'uCut']) G.loc[n] = O.getUniformLocation.call(gl, G.prog, n);
                O.useProgram.call(gl, G.prog);
                gl.uniform1i(G.loc.uClsTex, 7);
                gl.uniform1i(G.loc.uTex, 0);
                G.shadowOk = true;
                console.info(TAG, 'Shadow map ready (' + size + 'x' + size + ')');
            }
        } catch (e) {
            console.error(TAG, 'Could not initialize shadows:', e);
            G.shadowOk = false;
        } finally {
            O.useProgram.call(gl, prevProg);
            gl.activeTexture(prevActive);
        }
    }

    // classify each texture layer: 1 leaves, 2 plants, 3 water, 4 emissive
    function tryClasses(gl) {
        const mc = window.__mc, eng = mc && mc.eng;
        if (!eng || !eng.ft || !eng.kind || !eng.blockNames) return;
        const names = eng.blockNames, ft = eng.ft, kind = eng.kind;
        let max = 0;
        for (let i = 0; i < ft.length; i++) if (ft[i] > max) max = ft[i];
        const W = Math.min(gl.getParameter(gl.MAX_TEXTURE_SIZE), Math.max(1024, max + 1));
        const data = new Uint8Array(W * 4);
        const counts = [0, 0, 0, 0, 0];
        for (let id = 1; id < names.length; id++) {
            const name = String(names[id] || '');
            let cls = 0;
            if (/lava|magma|lumen|glowstone|torch|lantern|fire|beacon|shroomlight/i.test(name)) cls = 4;
            else if (/leaves/i.test(name)) cls = 1;
            else if (kind[id] === 5) cls = 2;
            else if (/water/i.test(name)) cls = 3;
            if (!cls) continue;
            for (let f = 0; f < 6; f++) {
                const lay = ft[id * 6 + f];
                if (lay >= 0 && lay < W && cls > data[lay * 4]) { data[lay * 4] = cls; }
            }
        }
        for (let i = 0; i < W; i++) counts[data[i * 4]]++;
        const prevActive = gl.getParameter(gl.ACTIVE_TEXTURE);
        gl.activeTexture(gl.TEXTURE7);
        gl.bindTexture(gl.TEXTURE_2D, G.clsTex);
        gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA8, W, 1, 0, gl.RGBA, gl.UNSIGNED_BYTE, data);
        gl.activeTexture(prevActive);
        G.clsDone = true;
        console.info(TAG, 'Layers classified -> leaves:', counts[1], 'plants:', counts[2], 'water:', counts[3], 'emissive:', counts[4]);
    }

    function applyUniforms(gl, info) {
        const st = updateState();
        if (!G.clsDone && G.clsTex && (G.clsTry++ % 30) === 0) {
            try { tryClasses(gl); } catch (e) { console.error(TAG, 'tryClasses:', e); G.clsDone = true; }
        }
        let L = info.loc;
        if (!L) {
            L = {};
            for (const n of UNIFORMS) L[n] = O.getUniformLocation.call(gl, info.prog, n);
            info.loc = L;
        }
        if (L.uFx) gl.uniform1f(L.uFx, CFG.enabled ? 1 : 0);
        if (L.uTime) gl.uniform1f(L.uTime, st.time);
        if (L.uCam) gl.uniform3f(L.uCam, st.cam[0], st.cam[1], st.cam[2]);
        if (L.uSunDir) gl.uniform3fv(L.uSunDir, st.sunL);
        if (L.uSunCol) gl.uniform3fv(L.uSunCol, st.sunCol);
        if (L.uZenith) gl.uniform3fv(L.uZenith, st.zenith);
        if (L.uSkySun) gl.uniform3fv(L.uSkySun, st.sun);
        if (L.uDay) gl.uniform1f(L.uDay, st.day);
        if (L.uSkyDay) gl.uniform1f(L.uSkyDay, st.day);
        if (L.uDim) gl.uniform1f(L.uDim, st.dim);
        if (L.uShadowOn) gl.uniform1f(L.uShadowOn, st.shadowOn);
        if (L.uLVP) gl.uniformMatrix4fv(L.uLVP, false, st.lvp);
        if (L.uShadowMap) gl.uniform1i(L.uShadowMap, 6);
        if (L.uClsTex) gl.uniform1i(L.uClsTex, 7);
        if (L.uCloudTint) gl.uniform3fv(L.uCloudTint, st.cloud);
    }

    proto.useProgram = function (p) {
        const gl = this;
        if (!G.init && p && progInfo.get(p)) initGL(gl);
        O.useProgram.call(gl, p);
        curInfo = p ? (progInfo.get(p) || null) : null;
        if (curInfo) {
            try { applyUniforms(gl, curInfo); } catch (e) { console.error(TAG, 'applyUniforms:', e); }
        }
    };

    // =====================================================================
    //  Shadow map render (reuses the chunks the game drew earlier).
    //  Only runs when updateState() asked for a refresh.
    // =====================================================================
    function renderShadow(gl) {
        const st = updateState();
        if (!G.shadowOk || !st.shadowOn || !st.refresh) return;

        const prevFB = gl.getParameter(gl.DRAW_FRAMEBUFFER_BINDING);
        const prevVP = Array.from(gl.getParameter(gl.VIEWPORT));
        const prevProg = gl.getParameter(gl.CURRENT_PROGRAM);
        const prevVAO = gl.getParameter(gl.VERTEX_ARRAY_BINDING);
        const wasCull = gl.isEnabled(gl.CULL_FACE), wasBlend = gl.isEnabled(gl.BLEND);
        const wasDepth = gl.isEnabled(gl.DEPTH_TEST), wasPO = gl.isEnabled(gl.POLYGON_OFFSET_FILL);
        const wasScissor = gl.isEnabled(gl.SCISSOR_TEST);
        const prevMask = gl.getParameter(gl.DEPTH_WRITEMASK), prevFunc = gl.getParameter(gl.DEPTH_FUNC);

        try {
            const size = CFG.shadowSize, U = G.loc;
            gl.bindFramebuffer(gl.DRAW_FRAMEBUFFER, G.fbo);
            gl.viewport(0, 0, size, size);
            gl.disable(gl.CULL_FACE); gl.disable(gl.BLEND); gl.disable(gl.SCISSOR_TEST);
            gl.enable(gl.DEPTH_TEST); gl.depthFunc(gl.LEQUAL); gl.depthMask(true);
            gl.enable(gl.POLYGON_OFFSET_FILL); gl.polygonOffset(2.0, 4.0);
            O.clear.call(gl, gl.DEPTH_BUFFER_BIT);
            O.useProgram.call(gl, G.prog);

            const SH = G.sh, c0 = SH.c0, R = SH.R, Uv = SH.U, ext = CFG.shadowExtent;
            gl.uniformMatrix4fv(U.uLVP, false, lightMat(SCRATCH, c0));
            // half of the chunk box (8 x 64 x 8) projected onto the light axes: exact culling
            const hx = 8 * Math.abs(R[0]) + 64 * Math.abs(R[1]) + 8 * Math.abs(R[2]);
            const hy = 8 * Math.abs(Uv[0]) + 64 * Math.abs(Uv[1]) + 8 * Math.abs(Uv[2]);
            const now = performance.now();
            let lastCut = -1, n = 0;
            for (const [vao, e] of rec) {
                if (now - e.seen > 15000) { rec.delete(vao); continue; }
                const cx = e.wx + 8 - c0[0], cy = e.wy + 64 - c0[1], cz = e.wz + 8 - c0[2];
                const sx = R[0] * cx + R[1] * cy + R[2] * cz + SH.dx;
                const sy = Uv[0] * cx + Uv[1] * cy + Uv[2] * cz + SH.dy;
                if (Math.abs(sx) > ext + hx || Math.abs(sy) > ext + hy) continue;
                if (e.cut !== lastCut) { gl.uniform1f(U.uCut, e.cut); lastCut = e.cut; }
                O.uniform3f.call(gl, U.uOrigin, e.wx - c0[0], e.wy - c0[1], e.wz - c0[2]);
                O.bindVertexArray.call(gl, vao);
                O.drawElements.call(gl, gl.TRIANGLES, e.n, gl.UNSIGNED_INT, 0);
                n++;
            }
            STATS.shadowChunks = n;
            STATS.refreshes++;
            SH.drawn = true;
        } finally {
            O.useProgram.call(gl, prevProg);
            O.bindVertexArray.call(gl, prevVAO);
            gl.bindFramebuffer(gl.DRAW_FRAMEBUFFER, prevFB);
            gl.viewport(prevVP[0], prevVP[1], prevVP[2], prevVP[3]);
            gl.polygonOffset(0, 0);
            if (!wasPO) gl.disable(gl.POLYGON_OFFSET_FILL);
            if (wasCull) gl.enable(gl.CULL_FACE);
            if (wasBlend) gl.enable(gl.BLEND);
            if (!wasDepth) gl.disable(gl.DEPTH_TEST);
            if (wasScissor) gl.enable(gl.SCISSOR_TEST);
            gl.depthMask(prevMask); gl.depthFunc(prevFunc);
        }
    }

    proto.drawElements = function (mode, count, type, offset) {
        const info = curInfo;
        if (info && info.terrain && info.mode < 2 && G.shadowOk) {
            const gl = this;
            if (shadowFrame !== frameId) {
                shadowFrame = frameId;
                try { if (ST.refresh) renderShadow(gl); } catch (e) { console.error(TAG, 'renderShadow:', e); G.shadowOk = false; }
            }
            if (curVAO && haveOrigin) {
                const cam = ST.cam;
                rec.set(curVAO, {
                    n: count,
                    wx: lastOrigin[0] + cam[0], wy: lastOrigin[1] + cam[1], wz: lastOrigin[2] + cam[2],
                    cut: info.mode === 1 ? 1 : 0, seen: performance.now()
                });
            }
        }
        return O.drawElements.call(this, mode, count, type, offset);
    };

    // =====================================================================
    //  Extras
    // =====================================================================
    window.Twitterentary = { cfg: CFG, state: ST, stats: STATS, shadow: G.sh };
    function notify(text) {
        try {
            const mc = window.__mc;
            if (mc && mc.S) mc.S.toast = { text, until: performance.now() + 2000 };
        } catch (e) { /* ignore */ }
    }
    addEventListener('keydown', e => {
        if (e.code !== 'KeyK' || e.repeat || e.ctrlKey || e.metaKey || e.altKey) return;
        const t = e.target, mc = window.__mc;
        if (t && (t.tagName === 'INPUT' || t.tagName === 'TEXTAREA' || t.isContentEditable)) return;
        if (mc && mc.S && mc.S.chatOpen) return;
        CFG.enabled = !CFG.enabled;
        console.info(TAG, 'Shaders ' + (CFG.enabled ? 'ON' : 'OFF'));
        notify('Twitterentary shaders: ' + (CFG.enabled ? 'ON' : 'OFF'));
    }, true);

    console.info(TAG, 'Twitterentary v1.1.0 loaded. Press K to toggle shaders. Config: Twitterentary.cfg');
})();
