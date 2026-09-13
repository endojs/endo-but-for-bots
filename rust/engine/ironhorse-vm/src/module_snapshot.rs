//! Capture the supported static module model without losing its live cells.
use crate::module::*;
use crate::snapshot_api::{ModuleGraphSnapshot, ModuleRecordRow};
use crate::{Kind, Slot};

fn primitive(slot: Slot) -> bool {
    matches!(
        slot.kind,
        Kind::Undefined | Kind::Null | Kind::Boolean | Kind::Integer | Kind::Number
    ) && slot.id == 0
        && slot.flag == 0
        && slot.next.is_null()
        && match slot.kind {
            Kind::Undefined | Kind::Null => slot.value == crate::Payload::None,
            Kind::Boolean => matches!(slot.value, crate::Payload::Boolean(_)),
            Kind::Integer => matches!(slot.value, crate::Payload::Integer(_)),
            Kind::Number => matches!(slot.value, crate::Payload::Number(_)),
            _ => false,
        }
}

impl ModuleGraph {
    pub(crate) fn snapshot_admitted(&self) -> bool {
        self.modules.iter().all(|m| {
            !matches!(m.status, ModuleStatus::Linking | ModuleStatus::Evaluating)
                && m.body.iter().all(|op| match op {
                    BodyOp::InitLocal { value, .. } => primitive(*value),
                    _ => true,
                })
        }) && self.cells.iter().all(|c| match c {
            CellState::Ready(ModuleValue::Value(v)) => primitive(*v),
            _ => true,
        })
    }
    pub(crate) fn snapshot(&self) -> ModuleGraphSnapshot {
        ModuleGraphSnapshot {
            modules: self
                .modules
                .iter()
                .map(|m| ModuleRecordRow {
                    specifier: m.specifier.clone(),
                    imports: m
                        .imports
                        .iter()
                        .map(|i| {
                            (
                                i.module_request.clone(),
                                match &i.import_name {
                                    ImportName::Namespace => None,
                                    ImportName::Named(n) => Some(n.clone()),
                                },
                                i.local_name.clone(),
                            )
                        })
                        .collect(),
                    exports: m
                        .exports
                        .iter()
                        .map(|e| match e {
                            ExportEntry::Local {
                                export_name,
                                local_name,
                            } => (0, export_name.clone(), local_name.clone(), String::new()),
                            ExportEntry::Indirect {
                                export_name,
                                module_request,
                                import_name,
                            } => (
                                1,
                                export_name.clone(),
                                module_request.clone(),
                                import_name.clone(),
                            ),
                            ExportEntry::Star { module_request } => {
                                (2, String::new(), module_request.clone(), String::new())
                            }
                        })
                        .collect(),
                    body: m
                        .body
                        .iter()
                        .map(|b| match b {
                            BodyOp::InitLocal { local_name, value } => {
                                (local_name.clone(), Some(*value))
                            }
                            BodyOp::ReadLocal { local_name } => (local_name.clone(), None),
                        })
                        .collect(),
                    status: match m.status {
                        ModuleStatus::New => 0,
                        ModuleStatus::Unlinked => 1,
                        ModuleStatus::Linking => 2,
                        ModuleStatus::Linked => 3,
                        ModuleStatus::Evaluating => 4,
                        ModuleStatus::Evaluated => 5,
                    },
                    environment: m
                        .env
                        .iter()
                        .map(|(n, id)| (n.clone(), id.0 as u32))
                        .collect(),
                    dfs_index: m.dfs_index as u32,
                    dfs_ancestor_index: m.dfs_ancestor_index as u32,
                })
                .collect(),
            cells: self
                .cells
                .iter()
                .map(|c| match c {
                    CellState::Uninitialized => (0, Slot::undefined(), u32::MAX),
                    CellState::Ready(ModuleValue::Value(v)) => (1, *v, u32::MAX),
                    CellState::Ready(ModuleValue::Namespace(m)) => {
                        (2, Slot::undefined(), m.0 as u32)
                    }
                })
                .collect(),
            dfs_counter: self.dfs_counter as u32,
        }
    }
    pub(crate) fn from_snapshot(state: ModuleGraphSnapshot) -> Result<Self, crate::RestoreError> {
        let refuse = || crate::RestoreError {
            row: "module_state",
            reason: "invalid static module graph",
        };
        let mut graph = Self::new();
        let count = state.modules.len();
        if state.dfs_counter as usize > count {
            return Err(refuse());
        }
        for (kind, value, module) in state.cells {
            graph.cells.push(match kind {
                0 if value == Slot::undefined() && module == u32::MAX => CellState::Uninitialized,
                1 if primitive(value) && module == u32::MAX => {
                    CellState::Ready(ModuleValue::Value(value))
                }
                2 if value == Slot::undefined() && (module as usize) < count => {
                    CellState::Ready(ModuleValue::Namespace(ModuleId(module as usize)))
                }
                _ => return Err(refuse()),
            });
        }
        for m in state.modules {
            if graph.by_specifier.contains_key(&m.specifier)
                || m.environment.windows(2).any(|p| p[0].0 >= p[1].0)
                || m.environment
                    .iter()
                    .any(|(_, i)| *i as usize >= graph.cells.len())
                || m.dfs_ancestor_index > m.dfs_index
                || (m.dfs_index != 0 && m.dfs_index as usize >= count)
            {
                return Err(refuse());
            }
            let status = match m.status {
                0 => ModuleStatus::New,
                1 => ModuleStatus::Unlinked,
                3 => ModuleStatus::Linked,
                5 => ModuleStatus::Evaluated,
                _ => return Err(refuse()),
            };
            let bound =
                |name: &String| m.environment.binary_search_by(|(n, _)| n.cmp(name)).is_ok();
            if matches!(status, ModuleStatus::Linked | ModuleStatus::Evaluated) {
                if m.imports.iter().any(|(_, _, local)| !bound(local))
                    || m.exports
                        .iter()
                        .any(|(kind, _, local, _)| *kind == 0 && !bound(local))
                    || m.body
                        .iter()
                        .any(|(local, value)| value.is_some() && !bound(local))
                {
                    return Err(refuse());
                }
            } else if !m.environment.is_empty() || m.dfs_index != 0 || m.dfs_ancestor_index != 0 {
                return Err(refuse());
            }
            let imports = m
                .imports
                .into_iter()
                .map(|(request, name, local)| ImportEntry {
                    module_request: request,
                    import_name: name.map_or(ImportName::Namespace, ImportName::Named),
                    local_name: local,
                })
                .collect();
            let exports = m
                .exports
                .into_iter()
                .map(|(kind, name, source, import)| match kind {
                    0 if import.is_empty() => Ok(ExportEntry::Local {
                        export_name: name,
                        local_name: source,
                    }),
                    1 => Ok(ExportEntry::Indirect {
                        export_name: name,
                        module_request: source,
                        import_name: import,
                    }),
                    2 if name.is_empty() && import.is_empty() => Ok(ExportEntry::Star {
                        module_request: source,
                    }),
                    _ => Err(refuse()),
                })
                .collect::<Result<Vec<_>, _>>()?;
            let body = m
                .body
                .into_iter()
                .map(|(name, value)| match value {
                    Some(value) if primitive(value) => Ok(BodyOp::InitLocal {
                        local_name: name,
                        value,
                    }),
                    None => Ok(BodyOp::ReadLocal { local_name: name }),
                    _ => Err(refuse()),
                })
                .collect::<Result<Vec<_>, _>>()?;
            graph
                .by_specifier
                .insert(m.specifier.clone(), ModuleId(graph.modules.len()));
            graph.modules.push(ModuleRecord {
                specifier: m.specifier,
                imports,
                exports,
                body,
                status,
                env: m
                    .environment
                    .into_iter()
                    .map(|(n, i)| (n, CellId(i as usize)))
                    .collect(),
                dfs_index: m.dfs_index as usize,
                dfs_ancestor_index: m.dfs_ancestor_index as usize,
            });
        }
        graph.dfs_counter = state.dfs_counter as usize;
        Ok(graph)
    }
}
