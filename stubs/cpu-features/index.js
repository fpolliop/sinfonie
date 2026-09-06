// ssh2 does `require('cpu-features')()` inside try/catch and falls back to a generic cipher list.
module.exports = function cpuFeaturesUnavailable() {
  throw new Error('cpu-features is stubbed in Sinfonie; ssh2 uses its default cipher preferences.')
}
