// ==UserScript==
// @name         Twitterentary shaders
// @namespace    tweetcraft.twitterentary
// @version      1.3.0
// @author       andrestube123
// @description  Adds shader-style lighting, waving plants, reflective water, and dynamic sky and clouds to TweetCraft.
// @match        https://tweetcraft.jai.vin/*
// @run-at       document-start
// @grant        none
// ==/UserScript==

(() => {
    'use strict';

    const TAG = '[Twitterentary]';

    const CFG = {
        enabled: true,
        shadows: true,
        shadowSize: 2048,
        shadowExtent: 56,
        shadowDepth: 256,
        shadowEvery: 8,
        shadowMove: 6,
        shadowTaps: 8,

        waving: true,
        leafSway: 0.028,
        plantSway: 0.075,

        waterEffects: true,
        waveStrength: 1.0,

        skyEffects: true,
        cloudEffects: true,

        sunStrength: 0.90,
        ambientStrength: 1.0,
        blockLight: 1.0,
        aoPower: 1.5,
        exposure: 1.0,
        saturation: 1.12,
        contrast: 1.05,
        emissive: 1.15
    };

    for (const k in CFG) {
        try {
            const v = localStorage.getItem('tc.shader.' + k);
            if (v === null) continue;
            if (typeof CFG[k] === 'boolean') { CFG[k] = (v === 'true'); continue; }
            const n = Number(v);
            if (Number.isFinite(n)) CFG[k] = n;
        } catch (e) {}
    }

    const SCHEMA = [
        { key: 'enabled', label: 'Shaders on', type: 'bool' },
        { key: 'shadows', label: 'Sun shadows', type: 'bool' },
        { key: 'waving', label: 'Waving leaves & plants', type: 'bool' },
        { key: 'leafSway', label: 'Leaf sway', type: 'num', min: 0, max: 0.15, step: 0.002 },
        { key: 'plantSway', label: 'Plant sway', type: 'num', min: 0, max: 0.3, step: 0.005 },
        { key: 'sunStrength', label: 'Sun light', type: 'num', min: 0, max: 2, step: 0.05 },
        { key: 'ambientStrength', label: 'Ambient light', type: 'num', min: 0, max: 2, step: 0.05 },
        { key: 'blockLight', label: 'Block light', type: 'num', min: 0, max: 2, step: 0.05 },
        { key: 'aoPower', label: 'Contact shadows (AO)', type: 'num', min: 0.5, max: 3, step: 0.1 },
        { key: 'emissive', label: 'Emissive glow', type: 'num', min: 0, max: 2, step: 0.05 },
        { key: 'exposure', label: 'Exposure', type: 'num', min: 0.4, max: 2, step: 0.05 },
        { key: 'saturation', label: 'Saturation', type: 'num', min: 0, max: 2, step: 0.02 },
        { key: 'contrast', label: 'Contrast', type: 'num', min: 0.5, max: 1.8, step: 0.02 },
        { key: 'waterEffects', label: 'Water effects', type: 'bool', reload: true },
        { key: 'waveStrength', label: 'Wave strength', type: 'num', min: 0, max: 2, step: 0.05 },
        { key: 'skyEffects', label: 'Sky', type: 'bool', reload: true },
        { key: 'cloudEffects', label: 'Clouds', type: 'bool', reload: true },
        { key: 'shadowSize', label: 'Shadow resolution', type: 'num', min: 1024, max: 4096, step: 1024, reload: true },
        { key: 'shadowExtent', label: 'Shadow range (blocks)', type: 'num', min: 16, max: 96, step: 8, reload: true },
        { key: 'shadowTaps', label: 'Shadow softness', type: 'num', min: 4, max: 16, step: 2, reload: true },
        { key: 'shadowEvery', label: 'Shadow update (frames)', type: 'num', min: 1, max: 30, step: 1 },
        { key: 'shadowMove', label: 'Shadow update (blocks)', type: 'num', min: 1, max: 16, step: 1 }
    ];

    const proto = window.WebGL2RenderingContext && WebGL2RenderingContext.prototype;
    if (!proto) return;

    const O = {};
    for (const k of ['shaderSource', 'compileShader', 'attachShader', 'linkProgram', 'useProgram',
        'bindVertexArray', 'deleteVertexArray', 'getUniformLocation', 'uniform3f', 'uniform3fv', 'uniform1f',
        'drawElements', 'clear', 'texImage3D', 'texSubImage3D']) {
        O[k] = proto[k];
    }

    const clamp01 = x => Math.min(1, Math.max(0, x));
    const sstep = (a, b, x) => { const t = clamp01((x - a) / (b - a)); return t * t * (3 - 2 * t); };
    const mixv = (a, b, t) => a.map((v, i) => v + (b[i] - v) * t);
    const norm = v => { const l = Math.hypot(v[0], v[1], v[2]) || 1; return [v[0] / l, v[1] / l, v[2] / l]; };
    const cross = (a, b) => [a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]];
    const dot = (a, b) => a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
    const F = n => Number(n).toFixed(4);

    function patchTerrainVS(src) {
        const re = /vec3\s+p\s*=\s*vec3\(\s*aPos\s*&\s*uvec3\(\s*0x1FFu\s*,\s*0xFFFu\s*,\s*0x1FFu\s*\)\s*\)\s*\*\s*0\.0625\s*\+\s*uOrigin\s*;/;
        if (!/aPos\s*&\s*uvec3/.test(src) || !src.includes('uniform vec3 uOrigin;') ||
            !re.test(src) || !src.includes('out vec2 vLight;')) return null;

        let s = src.replace('uniform vec3 uOrigin;', () =>
            'uniform vec3 uOrigin;\nuniform highp sampler2D uClsTex;\nuniform vec3 uCam;\nuniform float uTime;\nuniform float uFx;' +
            '\nuniform float uWaveOn;\nuniform float uLeafSway;\nuniform float uPlantSway;');
        s = s.replace('out vec2 vLight;', () => 'out vec2 vLight;\nout vec3 vRel;\nflat out float vCls;');

        const wave = `
  if (uFx > 0.5 && uWaveOn > 0.5 && tcC > 0.5 && tcC < 2.5) {
    vec3 tcW = p + uCam;
    float tcPl = tcC > 1.5 ? 1.0 : 0.0;
    // plants: the base (v=1) stays fixed, the tip moves
    float tcWt = tcPl > 0.5 ? 1.0 - float((aInfo.y >> 1u) & 1u) : 1.0;
    float tcG = 0.55 + 0.9 * (0.5 + 0.5 * sin(tcW.x * 0.11 + tcW.z * 0.07 + uTime * 0.45));
    float tcA = sin(uTime * 1.7 + tcW.x * 1.30 + tcW.z * 0.90) + 0.5 * sin(uTime * 3.1 + tcW.x * 2.30 - tcW.z * 1.70);
    float tcB = sin(uTime * 1.4 + tcW.z * 1.20 - tcW.x * 0.70) + 0.5 * sin(uTime * 2.7 - tcW.z * 2.10 + tcW.x * 1.90);
    float tcAmp = mix(uLeafSway, uPlantSway, tcPl) * tcWt * tcG;
    p.x += tcA * tcAmp;
    p.z += tcB * tcAmp;
    p.y += tcPl > 0.5 ? -abs(tcA + tcB) * tcAmp * 0.2 : tcB * tcAmp * 0.3;
  }`;

        return s.replace(re, m => `${m}
  vRel = p;
  float tcC = floor(texelFetch(uClsTex, ivec2(int(aInfo.x), 0), 0).r * 255.0 + 0.5);
  vCls = tcC;${wave}`);
    }

    function fsDecls() {
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
uniform float uWaveStr;
uniform float uAoPow;
uniform float uAmbStr;
uniform float uBlockStr;
uniform float uSunStr;
uniform float uEmissive;
uniform float uExposure;
uniform float uSaturation;
uniform float uContrast;
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
  return g * uWaveStr;
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
  float tcAO = pow(clamp(vShade / tcExp, 0.0, 1.0), uAoPow);

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
  vec3 tcAmbient = tcAmb * uAmbStr * (0.14 + 0.86 * tcSkyK) ${ambFloor};

  // block light (torches, lava...)
  vec3 tcBlock = (vec3(1.0, 0.60, 0.30) * pow(tcBl, 2.2) * 1.5 ${blockEngine}) * uBlockStr;

  // sun + shadows (the shadow is only sampled where the sun can actually reach)
  float tcNdl = clamp(dot(tcNs, uSunDir) * 1.1 + 0.06, 0.0, 1.0);
  float tcSunMask = tcDay * smoothstep(0.0, 0.15, uSkySun.y) * smoothstep(0.5, 0.95, tcSky);
  if (uDim > 0.5) tcSunMask = 0.0;
  float tcVis = 1.0;
  if (uShadowOn > 0.5 && tcNdl > 0.001 && tcSunMask > 0.001) tcVis = tcShadow(vRel, tcN, tcNdl);
  vec3 tcSunL = uSunCol * (tcNdl * tcVis * tcSunMask * uSunStr);
  if (tcLeaf) {
    float tcBack = pow(clamp(dot(tcV, uSunDir), 0.0, 1.0), 3.0);
    tcSunL += c.rgb * uSunCol * tcBack * tcVis * tcSunMask * 0.5;
  }

  vec3 tcLight = tcAmbient * tcAO + tcBlock * (0.6 + 0.4 * tcAO) + tcSunL * (0.55 + 0.45 * tcAO);
  vec3 tcCol = c.rgb * tcLight;
  if (tcEmit) tcCol = max(tcCol, c.rgb * uEmissive);
  float tcAlpha = ${alpha};
  ${water}

  // color grading
  tcCol *= uExposure;
  tcCol = tcTone(tcCol);
  float tcLum = dot(tcCol, vec3(0.299, 0.587, 0.114));
  tcCol = mix(vec3(tcLum), tcCol, uSaturation);
  tcCol = clamp((tcCol - 0.5) * uContrast + 0.5, 0.0, 1.0);

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

        let s = src.replace(mainRe, mm => fsDecls() + '\n' + mm);
        s = s.replace(cRe, mm => `${mm}\n  vec3 tcDx = dFdx(vRel), tcDy = dFdy(vRel);`);
        s = s.replace(outRe, () => shadeCode(lit, alpha));
        return { src: s, info: { terrainFS: true, mode, lit } };
    }

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

    function patchCloud(src) {
        if (!CFG.cloudEffects) return null;
        const re = /if\\s*\\(\\s*c\\.a\\s*<\\s*0\\.02\\s*\\)\\s*discard\\s*;/;
        if (!src.includes('uniform vec4 uTint, uHole;') || !src.includes('uKind') || !re.test(src)) return null;
        let s = src.replace(/uniform\\s+int\\s+uKind\\s*;/, mm => mm + '\\nuniform vec3 uCloudTint;\\nuniform float uFx;');
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

    const FIXED_SUN = norm([0.62, 0.6, -0.5]);
    const OBS = {
        camOk: false,
        top: [0.47, 0.655, 1],
        topFrame: -9, sunSeen: true,
        sun: FIXED_SUN, sunFrame: -9,
        amb: 0, sl: [1, 1, 1],
        lit: false
    };
    const CAMLAST = [0, 0, 0];
    const locKind = new WeakMap();

    function setCam(x, y, z) { CAMLAST[0] = x; CAMLAST[1] = y; CAMLAST[2] = z; OBS.camOk = true; }
    function onSprite(x, y, z) {
        if (OBS.topFrame === frameId && !OBS.sunSeen) {
            const l = Math.hypot(x, y, z) || 1;
            OBS.sun = [x / l, y / l, z / l]; OBS.sunFrame = frameId; OBS.sunSeen = true;
        }
    }

    const ATL = { n: 0, stats: null, anim: new Set(), dirty: false, names: null };

    try {
        const origIdx = Array.prototype.indexOf;
        Array.prototype.indexOf = function (v, f) {
            if (v === 'oak_planks' && !ATL.names && this.length > 50 && typeof this[0] === 'string') {
                ATL.names = this.slice(); ATL.dirty = true;
            }
            return origIdx.call(this, v, f);
        };
    } catch (e) { console.warn(TAG, 'names hook failed', e); }
    const RE_EMIT = /lava|magma|lumen|glowstone|torch|lantern|fire|beacon|shroomlight|sea_lantern|jack_o|redstone_lamp_on|campfire/i;
    const RE_PLANT = /^(short_grass|grass|tall_grass.*|fern|large_fern.*|.*sapling|.*_tulip|poppy|dandelion|blue_orchid|allium|azure_bluet|oxeye_daisy|cornflower|lily_of_the_valley|rose_bush.*|peony.*|lilac.*|sunflower.*|dead_bush|sugar_cane|.*seagrass.*|kelp.*|wheat_stage.*|carrots_stage.*|potatoes_stage.*|beetroots_stage.*|vine|sweet_berry_bush.*|torchflower.*|pitcher.*|.*_roots|.*_sprouts|bush|flower.*)$/i;
    function nameClass(nm) {
        if (RE_EMIT.test(nm) && !/torch_top|lantern_top/.test(nm)) return 4;
        if (/leaves/i.test(nm)) return 1;
        if (/^water/i.test(nm)) return 3;
        if (RE_PLANT.test(nm)) return 2;
        return 0;
    }

    function readAtlas(px, n) {
        const u8 = new Uint8Array(px.buffer, px.byteOffset, Math.min(px.byteLength, n * 1024));
        const st = new Float32Array(n * 5);
        for (let l = 0; l < n; l++) {
            let tr = 0, op = 0, r = 0, g = 0, b = 0;
            const base = l * 1024;
            for (let i = 0; i < 256; i++) {
                const o = base + i * 4;
                if (o + 3 >= u8.length) break;
                if (u8[o + 3] < 128) { tr++; continue; }
                op++; r += u8[o]; g += u8[o + 1]; b += u8[o + 2];
            }
            const o5 = l * 5;
            st[o5] = tr / 256;
            if (op) { st[o5 + 1] = r / op; st[o5 + 2] = g / op; st[o5 + 3] = b / op; }
            st[o5 + 4] = op;
        }
        ATL.n = n; ATL.stats = st; ATL.dirty = true;
    }

    function layerClass(l) {
        if (ATL.names && l < ATL.names.length) {
            const c = nameClass(String(ATL.names[l]));
            if (c) return c;
            const q = ATL.stats; if (q) {
                const o = l * 5, tr = q[o], r = q[o + 1], g = q[o + 2], b = q[o + 3];
                if (q[o + 4] >= 8 && tr >= 0.45 && g > r * 1.10 && g > b * 1.15 && !/(glass|pane|bars|door|trapdoor|ladder|chain|rail|web|sign|banner|bed|frame|redstone|tripwire|vine_)/i.test(String(ATL.names[l]))) return 2;
            }
            return 0;
        }
        const s = ATL.stats, o = l * 5;
        const tr = s[o], r = s[o + 1], g = s[o + 2], b = s[o + 3], op = s[o + 4];
        if (op < 8) return 0;
        if (ATL.anim.has(l)) {
            if (b > r * 1.25 && b >= g * 0.9) return 3;
            if (r > b * 1.3 && r >= g * 0.75) return 4;
            return 0;
        }
        if (tr < 0.02 && r > 200 && g > 150 && r > g * 1.12 && g > b * 1.35) return 4;
        const green = g > r * 1.02 && g > b * 1.05;
        if (green && tr >= 0.03 && tr < 0.45) return 1;
        if (g > r * 1.10 && g > b * 1.15 && tr >= 0.45) return 2;
        return 0;
    }

    const CLS_COUNTS = [0, 0, 0, 0, 0];
    function uploadClasses(gl) {
        const n = ATL.n;
        const W = Math.min(gl.getParameter(gl.MAX_TEXTURE_SIZE), Math.max(1024, n));
        const data = new Uint8Array(W * 4);
        CLS_COUNTS.fill(0);
        for (let l = 0; l < n && l < W; l++) { const c = layerClass(l); data[l * 4] = c; CLS_COUNTS[c]++; }
        const prevActive = gl.getParameter(gl.ACTIVE_TEXTURE);
        gl.activeTexture(gl.TEXTURE7);
        gl.bindTexture(gl.TEXTURE_2D, G.clsTex);
        gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA8, W, 1, 0, gl.RGBA, gl.UNSIGNED_BYTE, data);
        gl.activeTexture(prevActive);
        ATL.dirty = false;
        console.info(TAG, 'Layers classified -> leaves:', CLS_COUNTS[1], 'plants:', CLS_COUNTS[2], 'water:', CLS_COUNTS[3], 'emissive:', CLS_COUNTS[4], '(of ' + n + ')');
    }

    const shaderSrc = new WeakMap();
    const progShaders = new WeakMap();
    const progInfo = new WeakMap();

    let curInfo = null, curVAO = null, frameId = 0, shadowFrame = -1;
    const lastOrigin = [0, 0, 0];
    let haveOrigin = false;
    const rec = new Map();

    const UNIFORMS = ['uTime', 'uCam', 'uSunDir', 'uSunCol', 'uZenith', 'uSkySun', 'uDay', 'uDim',
        'uFx', 'uShadowOn', 'uLVP', 'uShadowMap', 'uClsTex', 'uSkyDay', 'uCloudTint',
        'uWaveOn', 'uLeafSway', 'uPlantSway', 'uWaveStr', 'uAoPow', 'uAmbStr', 'uBlockStr',
        'uSunStr', 'uEmissive', 'uExposure', 'uSaturation', 'uContrast'];

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
            const info = { prog: p, loc: null, mode: 0, lit: false, gen: -1 };
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
        if (!r) return r;
        switch (name) {
            case 'uOrigin': locKind.set(r, 1); break;
            case 'uCam': if (O.getUniformLocation.call(this, p, 'uSize')) locKind.set(r, 2); break;
            case 'uTop': locKind.set(r, 3); break;
            case 'uC': locKind.set(r, 4); break;
            case 'uAmbient': locKind.set(r, 5); break;
            case 'uSkyLight': locKind.set(r, 6); break;
        }
        return r;
    };

    proto.uniform3f = function (loc, x, y, z) {
        const k = locKind.get(loc);
        if (k !== undefined) {
            if (k === 1) { lastOrigin[0] = x; lastOrigin[1] = y; lastOrigin[2] = z; haveOrigin = true; }
            else if (k === 2) setCam(x, y, z);
            else if (k === 4) onSprite(x, y, z);
        }
        return O.uniform3f.call(this, loc, x, y, z);
    };

    proto.uniform3fv = function (loc, v) {
        const k = locKind.get(loc);
        if (k !== undefined && v && v.length >= 3) {
            if (k === 2) setCam(v[0], v[1], v[2]);
            else if (k === 3) { OBS.top = [v[0], v[1], v[2]]; OBS.topFrame = frameId; OBS.sunSeen = false; }
            else if (k === 4) onSprite(v[0], v[1], v[2]);
            else if (k === 6) OBS.sl = [v[0], v[1], v[2]];
        }
        return O.uniform3fv.apply(this, arguments);
    };

    proto.uniform1f = function (loc, x) {
        if (locKind.get(loc) === 5) OBS.amb = x;
        return O.uniform1f.call(this, loc, x);
    };

    proto.texImage3D = function (target, level, ifmt, w, h, d) {
        try {
            if (target === 0x8C1A && level === 0 && w === 16 && h === 16 && arguments.length >= 10) {
                const px = arguments[9];
                if (px && ArrayBuffer.isView(px)) readAtlas(px, d);
            }
        } catch (e) { console.error(TAG, 'atlas read:', e); }
        return O.texImage3D.apply(this, arguments);
    };
    proto.texSubImage3D = function (target, level, xo, yo, zo) {
        if (target === 0x8C1A && level === 0 && !ATL.anim.has(zo)) { ATL.anim.add(zo); ATL.dirty = true; }
        return O.texSubImage3D.apply(this, arguments);
    };

    proto.bindVertexArray = function (v) { curVAO = v; return O.bindVertexArray.call(this, v); };
    proto.deleteVertexArray = function (v) { rec.delete(v); return O.deleteVertexArray.call(this, v); };
    proto.clear = function (mask) { if (mask & 0x4000) frameId++; return O.clear.call(this, mask); };

    const G = {
        init: false, clsTex: null, shadowOk: false, fbo: null, depthTex: null, prog: null, loc: null,
        sh: { valid: false, drawn: true, frame: -999, c0: [0, 0, 0], L: [0, 1, 0], R: [1, 0, 0], U: [0, 0, 1], dx: 0, dy: 0 }
    };

    function lightMat(m, at) {
        const SH = G.sh, E = CFG.shadowExtent, Zd = CFG.shadowDepth, R = SH.R, U = SH.U, L = SH.L;
        const d = [at[0] - SH.c0[0], at[1] - SH.c0[1], at[2] - SH.c0[2]];
        m[0] = R[0] / E; m[1] = U[0] / E; m[2] = -L[0] / Zd; m[3] = 0;
        m[4] = R[1] / E; m[5] = U[1] / E; m[6] = -L[1] / Zd; m[7] = 0;
        m[8] = R[2] / E; m[9] = U[2] / E; m[10] = -L[2] / Zd; m[11] = 0;
        m[12] = (dot(d, R) + SH.dx) / E; m[13] = (dot(d, U) + SH.dy) / E; m[14] = -dot(d, L) / Zd; m[15] = 1;
        return m;
    }

    const ST = {
        frame: -1, camFrame: -1, gen: 0, ms: 0, time: 0, cam: [0, 0, 0], sun: FIXED_SUN, sunL: FIXED_SUN, sunCol: [1, 1, 1],
        zenith: [0.47, 0.655, 1], cloud: [1, 1, 1], day: 1, dim: 0, shadowOn: 0, refresh: false,
        lvp: new Float32Array(16)
    };
    const STATS = { shadowChunks: 0, refreshes: 0 };
    const SCRATCH = new Float32Array(16);
    const isEnd = sl => Math.abs(sl[0] - 0.055) < 0.004 && Math.abs(sl[1] - 0.07) < 0.004 && Math.abs(sl[2] - 0.0625) < 0.004;

    function updateState() {
        if (ST.frame === frameId) return ST;
        ST.frame = frameId; ST.gen++;
        ST.ms = performance.now(); ST.time = ST.ms / 1000;
        ST.cam[0] = CAMLAST[0]; ST.cam[1] = CAMLAST[1]; ST.cam[2] = CAMLAST[2];

        let dim = 0;
        if (OBS.lit) { if (OBS.amb > 0.05) dim = 1; else if (isEnd(OBS.sl)) dim = 2; }
        ST.dim = dim;

        const day = dim ? 0 : clamp01(OBS.top[2]);
        const sun = dim ? FIXED_SUN : OBS.sun;
        ST.sun = sun; ST.day = day;
        ST.sunL = norm([sun[0], Math.max(sun[1], 0.14), sun[2]]);

        const h = sun[1], t = sstep(0, 0.35, h);
        ST.sunCol = mixv([1.0, 0.50, 0.24], [1.0, 0.95, 0.84], t);
        const tw = (1 - sstep(0.02, 0.45, h)) * day;
        ST.cloud = mixv([1, 1, 1], [1.0, 0.68, 0.50], tw);
        ST.zenith = OBS.top;
        return ST;
    }

    function finalizeShadow() {
        const SH = G.sh, E = CFG.shadowExtent, texel = 2 * E / CFG.shadowSize, cam = ST.cam;
        ST.shadowOn = (CFG.enabled && CFG.shadows && G.shadowOk && ST.dim === 0 && ST.sun[1] > 0.06 && ST.day > 0.1) ? 1 : 0;
        if (!ST.shadowOn) { SH.valid = false; ST.refresh = false; return; }
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
        lightMat(ST.lvp, cam);
    }

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

    function applyUniforms(gl, info) {
        const st = updateState();
        if (ATL.dirty && G.clsTex && ATL.stats) {
            try { uploadClasses(gl); } catch (e) { console.error(TAG, 'uploadClasses:', e); ATL.dirty = false; }
        }
        let L = info.loc;
        if (!L) {
            L = {};
            for (const n of UNIFORMS) L[n] = O.getUniformLocation.call(gl, info.prog, n);
            info.loc = L;
        }
        if (info.gen === st.gen) return;
        info.gen = st.gen;
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
        if (L.uWaveOn) gl.uniform1f(L.uWaveOn, CFG.waving ? 1 : 0);
        if (L.uLeafSway) gl.uniform1f(L.uLeafSway, CFG.leafSway);
        if (L.uPlantSway) gl.uniform1f(L.uPlantSway, CFG.plantSway);
        if (L.uWaveStr) gl.uniform1f(L.uWaveStr, CFG.waveStrength);
        if (L.uAoPow) gl.uniform1f(L.uAoPow, CFG.aoPower);
        if (L.uAmbStr) gl.uniform1f(L.uAmbStr, CFG.ambientStrength);
        if (L.uBlockStr) gl.uniform1f(L.uBlockStr, CFG.blockLight);
        if (L.uSunStr) gl.uniform1f(L.uSunStr, CFG.sunStrength);
        if (L.uEmissive) gl.uniform1f(L.uEmissive, CFG.emissive);
        if (L.uExposure) gl.uniform1f(L.uExposure, CFG.exposure);
        if (L.uSaturation) gl.uniform1f(L.uSaturation, CFG.saturation);
        if (L.uContrast) gl.uniform1f(L.uContrast, CFG.contrast);
    }

    function pushCam(gl, info) {
        const L = info.loc;
        if (!L) return;
        const c = ST.cam;
        if (L.uCam) gl.uniform3f(L.uCam, c[0], c[1], c[2]);
        if (L.uLVP) gl.uniformMatrix4fv(L.uLVP, false, ST.lvp);
        if (L.uShadowOn) gl.uniform1f(L.uShadowOn, ST.shadowOn);
        info.gen = ST.gen;
    }

    proto.useProgram = function (p) {
        const gl = this;
        if (!G.init && p && progInfo.get(p)) initGL(gl);
        O.useProgram.call(gl, p);
        curInfo = p ? (progInfo.get(p) || null) : null;
        if (curInfo) {
            if (curInfo.terrain) OBS.lit = !!curInfo.lit;
            try { applyUniforms(gl, curInfo); } catch (e) { console.error(TAG, 'applyUniforms:', e); }
        }
    };

    function renderShadow(gl) {
        if (!G.shadowOk || !ST.shadowOn || !ST.refresh) return;

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
            const hx = 8 * Math.abs(R[0]) + 64 * Math.abs(R[1]) + 8 * Math.abs(R[2]);
            const hy = 8 * Math.abs(Uv[0]) + 64 * Math.abs(Uv[1]) + 8 * Math.abs(Uv[2]);
            const now = ST.ms;
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

    function terrainDraw(gl, info, count) {
        let e = rec.get(curVAO);
        const o = lastOrigin;
        if (ST.camFrame !== frameId) {
            const prevCamFrame = ST.camFrame;
            ST.camFrame = frameId;
            const c = ST.cam;
            c[0] = CAMLAST[0]; c[1] = CAMLAST[1]; c[2] = CAMLAST[2];
            if (e && e.frame === prevCamFrame) { c[0] += e.ox - o[0]; c[1] += e.oy - o[1]; c[2] += e.oz - o[2]; }
            CAMLAST[0] = c[0]; CAMLAST[1] = c[1]; CAMLAST[2] = c[2];
            ST.gen++;
            finalizeShadow();
            if (info.mode < 2 && G.shadowOk && ST.refresh && shadowFrame !== frameId) {
                shadowFrame = frameId;
                renderShadow(gl);
            }
            pushCam(gl, info);
        }
        if (info.mode < 2) {
            if (!e) { e = { n: 0, ox: 0, oy: 0, oz: 0, wx: 0, wy: 0, wz: 0, cut: 0, seen: 0, frame: -9 }; rec.set(curVAO, e); }
            const c = ST.cam;
            e.n = count;
            e.ox = o[0]; e.oy = o[1]; e.oz = o[2];
            e.wx = o[0] + c[0]; e.wy = o[1] + c[1]; e.wz = o[2] + c[2];
            e.cut = info.mode === 1 ? 1 : 0;
            e.seen = ST.ms; e.frame = frameId;
        }
    }

    proto.drawElements = function (mode, count, type, offset) {
        const info = curInfo;
        if (info && info.terrain && curVAO && haveOrigin) {
            try { terrainDraw(this, info, count); } catch (e) { console.error(TAG, 'terrainDraw:', e); G.shadowOk = false; }
        }
        return O.drawElements.call(this, mode, count, type, offset);
    };

    function debug() {
        const r = a => a && Array.from(a).map(x => +Number(x).toFixed(3));
        const out = {
            version: '1.3.0', frameId, dim: ST.dim, day: +ST.day.toFixed(3), sun: r(ST.sun), cam: r(ST.cam),
            camSeen: OBS.camOk, sunSeenFrame: OBS.sunFrame, skyFrame: OBS.topFrame, litProgram: OBS.lit,
            ambient: OBS.amb, skyLight: r(OBS.sl), shadowOn: ST.shadowOn, shadowChunks: STATS.shadowChunks, refreshes: STATS.refreshes,
            layers: ATL.n, animated: ATL.anim.size, names: ATL.names ? ATL.names.reduce((a, n, i) => { const c = layerClass(i); if (c) (a[['', 'leaves', 'plants', 'water', 'emissive'][c]] ||= []).push(n); return a; }, {}) : null, classes: { leaves: CLS_COUNTS[1], plants: CLS_COUNTS[2], water: CLS_COUNTS[3], emissive: CLS_COUNTS[4] }
        };
        console.log(out);
        return out;
    }
    window.Twitterentary = { cfg: CFG, schema: SCHEMA, state: ST, stats: STATS, shadow: G.sh, obs: OBS, debug };

    function notify(text) {
        try {
            const n = document.getElementById('note');
            if (!n) return;
            n.textContent = text;
            n.classList.add('show');
            clearTimeout(notify.t);
            notify.t = setTimeout(() => n.classList.remove('show'), 1800);
        } catch (e) {}
    }
    addEventListener('keydown', e => {
        if (e.code !== 'KeyK' || e.repeat || e.ctrlKey || e.metaKey || e.altKey) return;
        const t = e.target;
        if (t && (t.tagName === 'INPUT' || t.tagName === 'TEXTAREA' || t.isContentEditable)) return;
        CFG.enabled = !CFG.enabled;
        console.info(TAG, 'Shaders ' + (CFG.enabled ? 'ON' : 'OFF'));
        notify('Twitterentary shaders: ' + (CFG.enabled ? 'ON' : 'OFF'));
    }, true);

    console.info(TAG, 'Twitterentary v1.3.0 loaded. Press K to toggle shaders. Config: Twitterentary.cfg | Schema: Twitterentary.schema | Diagnostics: Twitterentary.debug()');
})();