// markdown-it (behind react-native-markdown-display) imports Node's punycode; point Metro at the npm package.
const { getDefaultConfig } = require('expo/metro-config')
const config = getDefaultConfig(__dirname)
config.resolver.extraNodeModules = { ...(config.resolver.extraNodeModules || {}), punycode: require.resolve('punycode/') }
module.exports = config
