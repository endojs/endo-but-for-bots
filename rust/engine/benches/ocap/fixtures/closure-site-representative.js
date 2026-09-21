'use strict';
(function () {
function make0() { return function (value) { return value; }; }
  function make1(index) { var a = index; return function (value) { return value + a; }; }
  function make4(index) { var a = index; var b = index + 1; var c = index + 2; var d = index + 3; return function (value) { return value + a + b + c + d; }; }
  function make8(index) { var a = index; var b = index + 1; var c = index + 2; var d = index + 3; var e = index + 4; var f = index + 5; var g = index + 6; var h = index + 7; return function (value) { return value + a + b + c + d + e + f + g + h; }; }
  var closures = [];
  var checksum = 0;
  for (var index = 0; index < 512; index += 1) {
    closures.push(make0(), make1(index), make4(index), make8(index));
  }
  for (var closureIndex = 0; closureIndex < closures.length; closureIndex += 1) {
    checksum += closures[closureIndex](1);
  }
  return 'closure-site:512:' + checksum + ':' + closures.length;
}())
