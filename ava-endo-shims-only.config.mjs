export default {
  require: ['ses', '@endo/eventual-send/shim.js', '@endo/parcel/shim.js'],
  files: ['test/**/*.test.*'],
  timeout: '2m',
};
