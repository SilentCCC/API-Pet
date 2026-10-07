// Pixel sizes and selection rules adapted from the local Canvas project.
(function (root, factory) {
  if (typeof module === 'object' && module.exports) module.exports = factory();
  else root.imageConfig = factory();
})(globalThis, function () {
const DEFAULT_IMAGE_MODEL = "gpt-image-2";
const CUSTOM_IMAGE_RESOLUTION = "custom";
const AUTO_IMAGE_RESOLUTION = "auto";
const IMAGE_SIZE_CONFIG = {
  [DEFAULT_IMAGE_MODEL]: {
    resolutions: [AUTO_IMAGE_RESOLUTION, "1K", "2K", "4K"],
    ratios: ["1:1", "2:3", "3:2", "3:4", "4:3", "9:16", "16:9", "9:21", "21:9"],
    sizes: {
      "1K": {
        "1:1": [1024, 1024],
        "2:3": [1024, 1536],
        "3:2": [1536, 1024],
        "3:4": [1152, 1536],
        "4:3": [1536, 1152],
        "9:16": [864, 1536],
        "16:9": [1536, 864],
        "9:21": [656, 1536],
        "21:9": [1536, 656]
      },
      "2K": {
        "1:1": [2048, 2048],
        "2:3": [2048, 3072],
        "3:2": [3072, 2048],
        "3:4": [2304, 3072],
        "4:3": [3072, 2304],
        "9:16": [1152, 2048],
        "16:9": [2048, 1152],
        "9:21": [1536, 3584],
        "21:9": [3584, 1536]
      },
      "4K": {
        "1:1": [2880, 2880],
        "2:3": [2176, 3264],
        "3:2": [3264, 2176],
        "3:4": [2400, 3200],
        "4:3": [3200, 2400],
        "9:16": [2160, 3840],
        "16:9": [3840, 2160],
        "9:21": [1632, 3808],
        "21:9": [3808, 1632]
      }
    }
  },
  "grok-imagine-image": {
    resolutions: [AUTO_IMAGE_RESOLUTION, "1K", "2K"],
    ratios: ["1:1", "2:3", "3:2", "3:4", "4:3", "9:16", "16:9", "9:19.5", "19.5:9", "9:20", "20:9", "1:2", "2:1"],
    sizes: {
      "1K": {
        "1:1": [1024, 1024],
        "2:3": [1024, 1536],
        "3:2": [1536, 1024],
        "3:4": [1024, 1365],
        "4:3": [1365, 1024],
        "9:16": [864, 1536],
        "16:9": [1536, 864],
        "9:19.5": [709, 1536],
        "19.5:9": [1536, 709],
        "9:20": [691, 1536],
        "20:9": [1536, 691],
        "1:2": [768, 1536],
        "2:1": [1536, 768]
      },
      "2K": {
        "1:1": [2048, 2048],
        "2:3": [2048, 3072],
        "3:2": [3072, 2048],
        "3:4": [2048, 2731],
        "4:3": [2731, 2048],
        "9:16": [1728, 3072],
        "16:9": [3072, 1728],
        "9:19.5": [1418, 3072],
        "19.5:9": [3072, 1418],
        "9:20": [1382, 3072],
        "20:9": [3072, 1382],
        "1:2": [1536, 3072],
        "2:1": [3072, 1536]
      }
    }
  }
};

const SEEDREAM_IMAGE_SIZE_CONFIG = {
  resolutions: ["1K", "2K"],
  ratios: ["1:1", "2:3", "3:2", "3:4", "4:3", "9:16", "16:9"],
  sizes: {
    "1K": {
      "1:1": [1024, 1024], "2:3": [1024, 1536], "3:2": [1536, 1024],
      "3:4": [1152, 1536], "4:3": [1536, 1152], "9:16": [864, 1536], "16:9": [1536, 864]
    },
    "2K": {
      "1:1": [2048, 2048], "2:3": [2048, 3072], "3:2": [3072, 2048],
      "3:4": [2304, 3072], "4:3": [3072, 2304], "9:16": [1152, 2048], "16:9": [2048, 1152]
    }
  }
};
IMAGE_SIZE_CONFIG["seedream-v5-lite"] = SEEDREAM_IMAGE_SIZE_CONFIG;
IMAGE_SIZE_CONFIG["seedream-v5-pro"] = SEEDREAM_IMAGE_SIZE_CONFIG;
IMAGE_SIZE_CONFIG["seedream-5.0-lite"] = SEEDREAM_IMAGE_SIZE_CONFIG;
IMAGE_SIZE_CONFIG["seedream-5.0-pro"] = SEEDREAM_IMAGE_SIZE_CONFIG;

IMAGE_SIZE_CONFIG["grok-imagine-image-quality"] = IMAGE_SIZE_CONFIG["grok-imagine-image"];
IMAGE_SIZE_CONFIG["grok-imagine-image-2.0"] = IMAGE_SIZE_CONFIG["grok-imagine-image"];
IMAGE_SIZE_CONFIG["grok4.3-img"] = IMAGE_SIZE_CONFIG["grok-imagine-image"];
IMAGE_SIZE_CONFIG["grok4.5-img"] = IMAGE_SIZE_CONFIG["grok-imagine-image"];
IMAGE_SIZE_CONFIG["sensenova-u1.5-lite"] = {
  resolutions: [AUTO_IMAGE_RESOLUTION, "2K", "4K"],
  ratios: ["1:1", "16:9", "9:16", "2:3", "3:2"],
  sizes: {
    [AUTO_IMAGE_RESOLUTION]: { "1:1": [2048, 2048] },
    "2K": { "1:1": [2048, 2048], "16:9": [2720, 1536], "9:16": [1536, 2720], "2:3": [1664, 2496], "3:2": [2496, 1664] },
    "4K": { "1:1": [4096, 4096] }
  }
};
IMAGE_SIZE_CONFIG["sensenova-u1-fast"] = {
  resolutions: ["1K"],
  ratios: ["2:3", "3:2", "3:4", "4:3", "4:5", "5:4", "1:1", "16:9", "9:16", "21:9", "9:21"],
  sizes: {
    "1K": {
      "2:3": [1664, 2496],
      "3:2": [2496, 1664],
      "3:4": [1760, 2368],
      "4:3": [2368, 1760],
      "4:5": [1824, 2272],
      "5:4": [2272, 1824],
      "1:1": [2048, 2048],
      "16:9": [2752, 1536],
      "9:16": [1536, 2752],
      "21:9": [3072, 1376],
      "9:21": [1344, 3136]
    }
  }
};
for (const model of [
  "gemini-3-pro-image-preview",
  "gemini-3.1-flash-image-preview",
  "gemini-3-pro-image",
  "gemini-3.1-flash-image",
  "gemini-2.5-flash-image-preview",
  "gemini-2.5-flash-image"
]) IMAGE_SIZE_CONFIG[model] = IMAGE_SIZE_CONFIG[DEFAULT_IMAGE_MODEL];

function isGrokImageModel(model) {
  return /(^|\/)(?:grok-[^/]+|grok4\.(?:3|5)-img)$/i.test(String(model || "").trim());
}

function configForModel(model) {
  model = String(model || '').split('/').pop().toLowerCase();
  if (isGrokImageModel(model)) return IMAGE_SIZE_CONFIG["grok-imagine-image"];
  if (IMAGE_SIZE_CONFIG[model]) return IMAGE_SIZE_CONFIG[model];
  if (model.startsWith('seedream-')) return SEEDREAM_IMAGE_SIZE_CONFIG;
  if (model.startsWith('sensenova-')) return IMAGE_SIZE_CONFIG["sensenova-u1.5-lite"];
  if (model.startsWith('gemini-')) return IMAGE_SIZE_CONFIG[DEFAULT_IMAGE_MODEL];
  if (model.startsWith('gpt-')) return IMAGE_SIZE_CONFIG[DEFAULT_IMAGE_MODEL];
  return IMAGE_SIZE_CONFIG[model] || IMAGE_SIZE_CONFIG[DEFAULT_IMAGE_MODEL];
}

function normalizeCustomDimension(value, fallback, model) {
  const numeric = Math.round(Number(value));
  if (!Number.isFinite(numeric) || numeric <= 0) return fallback;
  if (isSenseLiteModel(model)) return Math.max(512, Math.min(4096, Math.round(numeric / 32) * 32));
  return Math.min(16384, numeric);
}

function customImageSizeSelection(model, width, height) {
  const fallback = isSenseLiteModel(model) ? 512 : 1024;
  let normalizedWidth = normalizeCustomDimension(width, fallback, model);
  let normalizedHeight = normalizeCustomDimension(height, fallback, model);
  if (isSenseLiteModel(model)) {
    if (normalizedWidth > normalizedHeight * 3) normalizedWidth = Math.max(512, Math.floor(normalizedHeight * 3 / 32) * 32);
    if (normalizedHeight > normalizedWidth * 3) normalizedHeight = Math.max(512, Math.floor(normalizedWidth * 3 / 32) * 32);
  }
  return { resolution: CUSTOM_IMAGE_RESOLUTION, ratio: CUSTOM_IMAGE_RESOLUTION, width: normalizedWidth, height: normalizedHeight, size: `${normalizedWidth}x${normalizedHeight}` };
}

function autoImageSizeSelection(model, ratio) {
  const config = configForModel(model);
  if (isGrokImageModel(model)) return { resolution: AUTO_IMAGE_RESOLUTION, ratio: AUTO_IMAGE_RESOLUTION, width: 1024, height: 1024, size: AUTO_IMAGE_RESOLUTION };
  const selectedRatio = config.ratios.includes(ratio) ? ratio : config.ratios[0];
  const [width, height] = config.sizes[config.resolutions.find((resolution) => resolution !== AUTO_IMAGE_RESOLUTION) || config.resolutions[0]][selectedRatio];
  return { resolution: AUTO_IMAGE_RESOLUTION, ratio: selectedRatio, width, height, size: AUTO_IMAGE_RESOLUTION };
}

function getImageSizeSelection({ model, resolution = "1K", ratio = "1:1", width, height } = {}) {
  if (resolution === CUSTOM_IMAGE_RESOLUTION && !isGrokImageModel(model)) return customImageSizeSelection(model, width, height);
  const config = configForModel(model);
  if (resolution === AUTO_IMAGE_RESOLUTION && config.resolutions.includes(AUTO_IMAGE_RESOLUTION)) return autoImageSizeSelection(model, ratio);
  const selectedResolution = config.resolutions.includes(resolution) ? resolution : config.resolutions[0];
  const selectedRatio = config.sizes[selectedResolution]?.[ratio] ? ratio : Object.keys(config.sizes[selectedResolution] || {})[0];
  const [resolvedWidth, resolvedHeight] = config.sizes[selectedResolution][selectedRatio];
  return { resolution: selectedResolution, ratio: selectedRatio, width: resolvedWidth, height: resolvedHeight, size: `${resolvedWidth}x${resolvedHeight}` };
}

function getImageSizeOptions(model, resolution) {
  const config = configForModel(model);
  const ratios = resolution && config.sizes[resolution] ? Object.keys(config.sizes[resolution]) : config.ratios;
  return { resolutions: config.resolutions, ratios };
}

function normalizeImageSizeSelection({ model, resolution, ratio, size, width, height } = {}) {
  if (resolution === CUSTOM_IMAGE_RESOLUTION && !isGrokImageModel(model)) {
    const sizeMatch = String(size || "").match(/^(\d+)x(\d+)$/i);
    return customImageSizeSelection(model, width ?? sizeMatch?.[1], height ?? sizeMatch?.[2]);
  }
  const config = configForModel(model);
  const requestedSize = String(size || "");
  if (requestedSize.toLowerCase() === AUTO_IMAGE_RESOLUTION) return autoImageSizeSelection(model, ratio);
  for (const currentResolution of config.resolutions) {
    if (currentResolution === AUTO_IMAGE_RESOLUTION) continue;
    for (const currentRatio of config.ratios) {
      const dimensions = config.sizes[currentResolution]?.[currentRatio];
      if (!dimensions) continue;
      const [width, height] = dimensions;
      if (requestedSize === `${width}x${height}`) return getImageSizeSelection({ model, resolution: currentResolution, ratio: currentRatio });
    }
  }
  return getImageSizeSelection({ model, resolution, ratio });
}

function formatImageRatioOption(selection) {
  return `${selection.ratio} (${selection.width} x ${selection.height})`;
}

function modelKind(model) {
  const name = String(model || '').split('/').pop().toLowerCase();
  if (name.startsWith('gemini-')) return 'gemini';
  if (name.startsWith('seedream-')) return 'seedream';
  if (name === 'sensenova-u1-fast') return 'sense-fast';
  if (name.startsWith('sensenova-')) return 'sense-lite';
  if (name === 'grok-imagine-image-2.0') return 'grok-json';
  if (isGrokImageModel(model)) return 'grok';
  if (name.startsWith('gpt-')) return 'generic';
  return 'generic';
}
function isSenseLiteModel(model) {
  const name = String(model || '').split('/').pop().toLowerCase();
  return name.startsWith('sensenova-') && name !== 'sensenova-u1-fast';
}
return { getImageSizeSelection, getImageSizeOptions, normalizeImageSizeSelection, modelKind };
});
