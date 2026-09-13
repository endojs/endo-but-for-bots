//! Format-21 shared Realm extension of the atomic FUNC payload.
use super::*;
use ironhorse_vm::snapshot_api::{
    EnvironmentRow, EvaluatorRow, PromiseJobRow, PromiseReactionRow, SharedMachineSnapshot,
};

pub(super) fn encode(state: &SharedMachineSnapshot, out: &mut Vec<u8>) {
    fn word(out: &mut Vec<u8>, x: u32) {
        out.extend_from_slice(&x.to_be_bytes());
    }
    fn words(out: &mut Vec<u8>, xs: &[u32]) {
        word(out, xs.len() as u32);
        for x in xs {
            word(out, *x);
        }
    }
    fn pairs(out: &mut Vec<u8>, xs: &[(u32, u32)]) {
        word(out, xs.len() as u32);
        for (x, y) in xs {
            word(out, *x);
            word(out, *y);
        }
    }
    out.extend_from_slice(b"SHRD");
    word(out, state.default_global);
    word(out, state.current_global);
    words(out, &state.intrinsic_roots);
    word(out, state.environments.len() as u32);
    for e in &state.environments {
        word(out, e.global);
        word(out, e.binding_names.len() as u32);
        for id in &e.binding_names {
            out.extend_from_slice(&id.to_be_bytes());
        }
        encode_modules(&e.modules, out);
        out.push(e.host_owned as u8);
        out.push(e.compiler_required as u8);
        word(out, e.unhandled_rejection.unwrap_or(u32::MAX));
    }
    pairs(out, &state.function_environments);
    pairs(out, &state.generator_environments);
    pairs(out, &state.async_environments);
    pairs(out, &state.promise_environments);
    word(out, state.evaluators.len() as u32);
    for e in &state.evaluators {
        word(out, e.owner);
        out.push(e.kind);
        word(out, e.name_chunk);
    }
    words(out, &state.roots);
    word(out, state.jobs.len() as u32);
    for j in &state.jobs {
        out.push(j.thenable as u8);
        out.push(j.rejected as u8);
        crate::slot_codec::encode_slot(&j.value, out);
        let r = &j.reaction;
        for v in [&r.on_fulfilled, &r.on_rejected, &r.resolve, &r.reject] {
            crate::slot_codec::encode_slot(v, out);
        }
        out.push(r.kind);
        word(out, r.a);
        word(out, r.b);
    }
    words(out, &state.pending_rejections);
}

pub(super) fn decode(c: &mut Cursor<'_>) -> Result<SharedMachineSnapshot, SnapshotError> {
    fn boolean(c: &mut Cursor<'_>) -> Result<bool, SnapshotError> {
        match c.u8()? {
            0 => Ok(false),
            1 => Ok(true),
            _ => Err(SnapshotError::Corrupt("shared machine boolean")),
        }
    }
    fn words(c: &mut Cursor<'_>) -> Result<Vec<u32>, SnapshotError> {
        let n = c.u32()?;
        (0..n).map(|_| c.u32()).collect()
    }
    fn pairs(c: &mut Cursor<'_>) -> Result<Vec<(u32, u32)>, SnapshotError> {
        let n = c.u32()?;
        (0..n).map(|_| Ok((c.u32()?, c.u32()?))).collect()
    }
    if c.bytes(4)? != b"SHRD" {
        return Err(SnapshotError::Corrupt("shared machine extension tag"));
    }
    let default_global = c.u32()?;
    let current_global = c.u32()?;
    let intrinsic_roots = words(c)?;
    let n = c.u32()?;
    let mut environments = Vec::new();
    for _ in 0..n {
        let global = c.u32()?;
        let n = c.u32()?;
        let binding_names = (0..n).map(|_| c.u16()).collect::<Result<Vec<_>, _>>()?;
        let modules = decode_modules(c)?;
        let host_owned = boolean(c)?;
        let compiler_required = boolean(c)?;
        let rejection = c.u32()?;
        environments.push(EnvironmentRow {
            global,
            binding_names,
            modules,
            host_owned,
            compiler_required,
            unhandled_rejection: (rejection != u32::MAX).then_some(rejection),
        });
    }
    let function_environments = pairs(c)?;
    let generator_environments = pairs(c)?;
    let async_environments = pairs(c)?;
    let promise_environments = pairs(c)?;
    let n = c.u32()?;
    let mut evaluators = Vec::new();
    for _ in 0..n {
        evaluators.push(EvaluatorRow {
            owner: c.u32()?,
            kind: c.u8()?,
            name_chunk: c.u32()?,
        });
    }
    let roots = words(c)?;
    let n = c.u32()?;
    let mut jobs = Vec::new();
    for _ in 0..n {
        let thenable = boolean(c)?;
        let rejected = boolean(c)?;
        let value = c.slot()?;
        let on_fulfilled = c.slot()?;
        let on_rejected = c.slot()?;
        let resolve = c.slot()?;
        let reject = c.slot()?;
        let kind = c.u8()?;
        let a = c.u32()?;
        let b = c.u32()?;
        jobs.push(PromiseJobRow {
            thenable,
            rejected,
            value,
            reaction: PromiseReactionRow {
                on_fulfilled,
                on_rejected,
                resolve,
                reject,
                kind,
                a,
                b,
            },
        });
    }
    let pending_rejections = words(c)?;
    Ok(SharedMachineSnapshot {
        default_global,
        current_global,
        intrinsic_roots,
        environments,
        function_environments,
        generator_environments,
        async_environments,
        promise_environments,
        evaluators,
        roots,
        jobs,
        pending_rejections,
    })
}

fn encode_modules(graph: &ironhorse_vm::snapshot_api::ModuleGraphSnapshot, out: &mut Vec<u8>) {
    fn word(out: &mut Vec<u8>, x: u32) {
        out.extend_from_slice(&x.to_be_bytes());
    }
    fn text(out: &mut Vec<u8>, s: &str) {
        word(out, s.len() as u32);
        out.extend_from_slice(s.as_bytes());
    }
    word(out, graph.modules.len() as u32);
    for m in &graph.modules {
        text(out, &m.specifier);
        word(out, m.imports.len() as u32);
        for (request, name, local) in &m.imports {
            text(out, request);
            out.push(name.is_some() as u8);
            if let Some(name) = name {
                text(out, name);
            }
            text(out, local);
        }
        word(out, m.exports.len() as u32);
        for (kind, name, source, import) in &m.exports {
            out.push(*kind);
            text(out, name);
            text(out, source);
            text(out, import);
        }
        word(out, m.body.len() as u32);
        for (name, value) in &m.body {
            text(out, name);
            out.push(value.is_some() as u8);
            if let Some(value) = value {
                crate::slot_codec::encode_slot(value, out);
            }
        }
        out.push(m.status);
        word(out, m.environment.len() as u32);
        for (name, cell) in &m.environment {
            text(out, name);
            word(out, *cell);
        }
        word(out, m.dfs_index);
        word(out, m.dfs_ancestor_index);
    }
    word(out, graph.cells.len() as u32);
    for (kind, value, module) in &graph.cells {
        out.push(*kind);
        crate::slot_codec::encode_slot(value, out);
        word(out, *module);
    }
    word(out, graph.dfs_counter);
}

fn decode_modules(
    c: &mut Cursor<'_>,
) -> Result<ironhorse_vm::snapshot_api::ModuleGraphSnapshot, SnapshotError> {
    use ironhorse_vm::snapshot_api::{ModuleGraphSnapshot, ModuleRecordRow};
    fn text(c: &mut Cursor<'_>) -> Result<String, SnapshotError> {
        let len = c.u32()? as usize;
        String::from_utf8(c.bytes(len)?.to_vec())
            .map_err(|_| SnapshotError::Corrupt("module name is not UTF-8"))
    }
    fn boolean(c: &mut Cursor<'_>) -> Result<bool, SnapshotError> {
        match c.u8()? {
            0 => Ok(false),
            1 => Ok(true),
            _ => Err(SnapshotError::Corrupt("module boolean")),
        }
    }
    let count = c.u32()?;
    let mut modules = Vec::new();
    for _ in 0..count {
        let specifier = text(c)?;
        let n = c.u32()?;
        let mut imports = Vec::new();
        for _ in 0..n {
            let request = text(c)?;
            let name = if boolean(c)? { Some(text(c)?) } else { None };
            imports.push((request, name, text(c)?));
        }
        let n = c.u32()?;
        let mut exports = Vec::new();
        for _ in 0..n {
            exports.push((c.u8()?, text(c)?, text(c)?, text(c)?));
        }
        let n = c.u32()?;
        let mut body = Vec::new();
        for _ in 0..n {
            let name = text(c)?;
            let value = if boolean(c)? { Some(c.slot()?) } else { None };
            body.push((name, value));
        }
        let status = c.u8()?;
        let n = c.u32()?;
        let mut environment = Vec::new();
        for _ in 0..n {
            environment.push((text(c)?, c.u32()?));
        }
        modules.push(ModuleRecordRow {
            specifier,
            imports,
            exports,
            body,
            status,
            environment,
            dfs_index: c.u32()?,
            dfs_ancestor_index: c.u32()?,
        });
    }
    let n = c.u32()?;
    let mut cells = Vec::new();
    for _ in 0..n {
        cells.push((c.u8()?, c.slot()?, c.u32()?));
    }
    Ok(ModuleGraphSnapshot {
        modules,
        cells,
        dfs_counter: c.u32()?,
    })
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn shared_extension_tags_and_booleans_are_strict() {
        assert_eq!(
            decode(&mut Cursor::new(b"NOPE", "short")),
            Err(SnapshotError::Corrupt("shared machine extension tag"))
        );
        let mut state = SharedMachineSnapshot::default();
        state.environments.push(EnvironmentRow {
            global: 0,
            binding_names: vec![],
            modules: Default::default(),
            host_owned: false,
            compiler_required: false,
            unhandled_rejection: None,
        });
        let mut bytes = Vec::new();
        encode(&state, &mut bytes);
        // Header, empty roots, environment count/global/names, then empty modules/cells/DFS.
        bytes[40] = 2;
        assert_eq!(
            decode(&mut Cursor::new(&bytes, "short")),
            Err(SnapshotError::Corrupt("shared machine boolean"))
        );
    }
    #[test]
    fn module_text_and_optional_names_are_strict() {
        let mut bytes = vec![];
        for word in [1u32, 1] {
            bytes.extend_from_slice(&word.to_be_bytes());
        }
        bytes.push(0xff);
        assert_eq!(
            decode_modules(&mut Cursor::new(&bytes, "short")),
            Err(SnapshotError::Corrupt("module name is not UTF-8"))
        );
        let mut bytes = vec![];
        // One module, empty specifier, one import, empty request, invalid presence flag.
        for word in [1u32, 0, 1, 0] {
            bytes.extend_from_slice(&word.to_be_bytes());
        }
        bytes.push(2);
        assert_eq!(
            decode_modules(&mut Cursor::new(&bytes, "short")),
            Err(SnapshotError::Corrupt("module boolean"))
        );
    }
}
