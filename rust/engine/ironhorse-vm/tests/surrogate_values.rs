//! Value-producing ToString paths must preserve every UTF-16 code unit.
use ironhorse_vm::{CompiledSource, Interp, SourceCompileError, SourceCompiler};

fn check(source: &str) {
    let (code, atoms) = ironhorse_compile::compile_atoms(source).expect("compile");
    let mut vm = Interp::new();
    vm.link_intrinsics(&ironhorse_vm::parse_symbols(&atoms));
    vm.set_source_compiler(std::rc::Rc::new(Compiler));
    let result = vm.run(&code);
    assert!(result.completed, "{source}: {:?}", result.halt);
    assert_eq!(result.result, "true", "{source}");
}

#[test]
fn primitive_and_wrapper_conversions_preserve_surrogates() {
    check(
        r#"
        var text = '\uD800\uDC01\uD801x\uDC00\uFFFD';
        var object = {toString() { return text; }};
        String(object) === text && new String(object).valueOf() === text &&
        String.prototype.toString.call(new String(text)) === text
    "#,
    );
}

#[test]
fn array_rendering_preserves_surrogates_in_elements_and_separators() {
    check(
        r#"
        var text = '\uD800';
        [text, text].join('\uDC00') === text + '\uDC00' + text &&
        [text, text].toString() === text + ',' + text &&
        [{toString() { return text; }}].join() === text
    "#,
    );
}

#[test]
fn errors_symbols_and_tags_preserve_surrogates() {
    check(
        r#"
        var text = '\uD800';
        var symbol = Symbol(text);
        var object = {[Symbol.toStringTag]: text};
        new Error(text).message === text &&
        new SuppressedError(1, 2, text).message === text &&
        String(symbol) === 'Symbol(' + text + ')' &&
        symbol.toString() === 'Symbol(' + text + ')' &&
        Object.prototype.toString.call(object) === '[object ' + text + ']'
    "#,
    );
}

#[test]
fn collation_does_not_fold_distinct_surrogates_or_skip_coercion() {
    check(
        r#"
        var compare = new Intl.Collator('en').compare;
        var log = '';
        var a = {toString() { log += 'a'; return '\uD800'; }};
        var b = {toString() { log += 'b'; return '\uD801'; }};
        var result = compare(a, b);
        log === 'ab' && result !== 0 && compare('\uD800', '\uFFFD') !== 0 &&
        '\uD800'.localeCompare('\uD801') !== 0 && compare('é', 'e\u0301') === 0
    "#,
    );
}

#[test]
fn list_format_preserves_elements_and_iterates_utf16_code_points() {
    check(
        r#"
        var formatter = new Intl.ListFormat('en');
        var parts = formatter.formatToParts(['\uD800', '\uDC00']);
        parts[0].value === '\uD800' && parts[2].value === '\uDC00' &&
        formatter.format(['\uD800']) === '\uD800' &&
        formatter.formatToParts('\uD800')[0].value === '\uD800'
    "#,
    );
}

#[test]
fn numeric_and_date_grammars_reject_unpaired_surrogates() {
    check(
        r#"
        var rejected = false;
        try { BigInt('\uD800'); } catch (error) { rejected = error instanceof SyntaxError; }
        rejected && Number.isNaN(Number('\uD800')) &&
        Number.isNaN(new Date('\uD800').valueOf()) &&
        !(1n < '\uD800') && !('\uD800' == 0)
    "#,
    );
}

struct Compiler;
impl SourceCompiler for Compiler {
    fn compile_source(
        &self,
        source: &str,
        strict: bool,
        raw_budget: u64,
        charge: &mut dyn FnMut(u64) -> bool,
    ) -> Result<CompiledSource, SourceCompileError> {
        match ironhorse_compile::compile_atoms_budgeted_with_limit(
            source,
            ironhorse_compile::Goal::Eval,
            strict,
            raw_budget,
            charge,
        ) {
            Ok(compiled) => Ok(ironhorse_vm::CompiledSource {
                bytecode: compiled.bytecode,
                symbols: compiled.symbols,
                parse_meter_raw: compiled.parse_meter_raw,
                parse_computrons: compiled.parse_computrons,
            }),
            Err(ironhorse_compile::CompileError::MeterAbort) => {
                Err(ironhorse_vm::SourceCompileError::MeterAbort)
            }
            Err(ironhorse_compile::CompileError::Parse(error)) => match error.kind {
                ironhorse_compile::ParseErrorKind::Lex(ironhorse_compile::LexError {
                    kind: ironhorse_compile::LexErrorKind::RegExpResourceLimit,
                    ..
                }) => Err(ironhorse_vm::SourceCompileError::HeapExhausted),
                ironhorse_compile::ParseErrorKind::Lex(ironhorse_compile::LexError {
                    kind: ironhorse_compile::LexErrorKind::RegExpBudgetExceeded,
                    ..
                }) => Err(ironhorse_vm::SourceCompileError::MeterAbort),
                ironhorse_compile::ParseErrorKind::Unsupported => Err(
                    ironhorse_vm::SourceCompileError::Unsupported(error.to_string()),
                ),
                _ => Err(ironhorse_vm::SourceCompileError::Syntax(error.message)),
            },
        }
    }

    fn compile_source_units(
        &self,
        source: &[u16],
        strict: bool,
        raw_budget: u64,
        charge: &mut dyn FnMut(u64) -> bool,
    ) -> Result<CompiledSource, SourceCompileError> {
        match ironhorse_compile::compile_atoms_units_budgeted_with_limit(
            source,
            ironhorse_compile::Goal::Eval,
            strict,
            raw_budget,
            charge,
        ) {
            Ok(compiled) => Ok(ironhorse_vm::CompiledSource {
                bytecode: compiled.bytecode,
                symbols: compiled.symbols,
                parse_meter_raw: compiled.parse_meter_raw,
                parse_computrons: compiled.parse_computrons,
            }),
            Err(ironhorse_compile::CompileError::MeterAbort) => {
                Err(ironhorse_vm::SourceCompileError::MeterAbort)
            }
            Err(ironhorse_compile::CompileError::Parse(error)) => match error.kind {
                ironhorse_compile::ParseErrorKind::Lex(ironhorse_compile::LexError {
                    kind: ironhorse_compile::LexErrorKind::RegExpResourceLimit,
                    ..
                }) => Err(ironhorse_vm::SourceCompileError::HeapExhausted),
                ironhorse_compile::ParseErrorKind::Lex(ironhorse_compile::LexError {
                    kind: ironhorse_compile::LexErrorKind::RegExpBudgetExceeded,
                    ..
                }) => Err(ironhorse_vm::SourceCompileError::MeterAbort),
                ironhorse_compile::ParseErrorKind::Unsupported => Err(
                    ironhorse_vm::SourceCompileError::Unsupported(error.to_string()),
                ),
                _ => Err(ironhorse_vm::SourceCompileError::Syntax(error.message)),
            },
        }
    }
}

#[test]
fn eval_and_function_preserve_literal_and_raw_template_source() {
    check(
        r#"
        var unit = '\uD800';
        var literal = "'" + unit + "'";
        var tag = function (strings) { return strings.raw[0]; };
        eval(literal) === unit && Function('return ' + literal)() === unit &&
        eval('tag`' + unit + '`') === unit &&
        eval('`' + unit + '${1}' + unit + '`') === unit + '1' + unit
    "#,
    );
}

#[test]
fn source_preserves_identity_escapes_and_regexp_literal_units() {
    check(
        r#"
        var unit = '\uD800';
        var slash = String.fromCharCode(92);
        var rejected = false;
        try { eval('/' + slash + unit + '/u'); }
        catch (error) { rejected = error instanceof SyntaxError; }
        rejected && eval('/' + unit + '/').test(unit) &&
        eval("'" + slash + unit + "'") === unit &&
        eval('String.raw`' + slash + unit + '`') === slash + unit
    "#,
    );
}

#[test]
fn regexp_source_matching_and_coercion_keep_original_units() {
    check(
        r#"
        var unit = '\uD800';
        var re = new RegExp(unit);
        re.source === unit && re.toString() === '/' + unit + '/' &&
        re.test(unit) && !re.test('\uFFFD') &&
        new RegExp(re).source === unit && new RegExp(unit, 'u').test(unit) &&
        new RegExp('😀', 'u').test('😀') && new RegExp('\u0000').source === '\u0000' && !new RegExp('\u0000').test('x')
    "#,
    );
}

#[test]
fn string_conversions_preserve_exceptions_and_symbol_rejection() {
    check(
        r#"
        var token = {};
        var object = {toString() { throw token; }};
        var symbolObject = {toString() { return Symbol(); }};
        var compare = new Intl.Collator('en').compare;
        var count = 0;
        try { String(object); } catch (error) { if (error === token) count++; }
        try { compare(object, ''); } catch (error) { if (error === token) count++; }
        try { new Error(symbolObject); } catch (error) { if (error instanceof TypeError) count++; }
        try { [symbolObject].join(); } catch (error) { if (error instanceof TypeError) count++; }
        try { compare(symbolObject, ''); } catch (error) { if (error instanceof TypeError) count++; }
        try { new Intl.Collator('en', {caseFirst: symbolObject}); } catch (error) { if (error instanceof TypeError) count++; }
        count === 6 && new Intl.ListFormat('en').formatToParts('😀').length === 1
    "#,
    );
}
