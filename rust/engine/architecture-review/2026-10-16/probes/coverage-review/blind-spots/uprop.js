var props = ['L','Lu','Ll','Lt','Lm','Lo','M','Mn','Mc','Me','N','Nd','Nl','No','P','Pc','Pd','Ps','Pe','Pi','Pf','Po','S','Sm','Sc','Sk','So','Z','Zs','Zl','Zp','C','Cc','Cf','Cs','Co','Cn',
  'Alphabetic','White_Space','ID_Start','ID_Continue','Uppercase','Lowercase','Emoji','Emoji_Presentation','Extended_Pictographic','Assigned','Default_Ignorable_Code_Point','Changes_When_Casefolded','Math','Dash',
  'Script=Latin','Script=Greek','Script=Cyrillic','Script=Han','Script=Arabic','Script=Hebrew','Script=Devanagari','Script=Hiragana','Script=Katakana','Script=Hangul','Script=Common','Script=Inherited','Script=Thai',
  'Script_Extensions=Latin','Script_Extensions=Han','Script_Extensions=Arabic','Script_Extensions=Devanagari','Script_Extensions=Greek'];
var LIMIT = 0x20000;
var out = {};
for (var i = 0; i < props.length; i++) {
  var re = new RegExp('^\\p{' + props[i] + '}$', 'u');
  var ranges = [];
  var inR = false, start = 0;
  for (var c = 0; c < LIMIT; c++) {
    var m = re.test(String.fromCodePoint(c));
    if (m && !inR) { inR = true; start = c; }
    else if (!m && inR) { inR = false; ranges.push(start, c - 1); }
  }
  if (inR) ranges.push(start, LIMIT - 1);
  out[props[i]] = ranges;
}
throw new Error(JSON.stringify(out));
