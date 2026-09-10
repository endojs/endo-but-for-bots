//! Private opcode semantics.
//! Return transfers unchanged; only the dispatch loop owns catch resumption.
use super::super::*;

impl Interp {
    pub(super) fn dispatch_new_private(&mut self, index: usize, flag: u8) -> Result<(), Step> {
        let brand = match self.closure_cell(index) {
            Some(cell) => cell,
            None => return Err(Step::Host(Halt::NotImplemented("private:missing-brand"))),
        };
        let value = self.pop();
        let receiver = self.pop();
        let object = match receiver.value {
            Payload::Reference(object) if receiver.kind == Kind::Reference => object,
            _ => {
                // Valid compiled private initialization always has an
                // instance receiver; this guards malformed VM input.
                let error = self.build_error("TypeError", 0, 0);
                return Err(self.raise_js(error));
            }
        };

        let key = (object, brand);
        if flag & XS_METHOD_FLAG != 0 {
            let home = self
                .functions
                .get(&self.cur_func)
                .map(|info| info.home)
                .unwrap_or(crate::value::SlotIndex::NULL);
            if let Payload::Reference(f) = value.value {
                self.functions.update(&f, |info| {
                    info.home = home;
                });
            }
        }
        if flag & (XS_GETTER_FLAG | XS_SETTER_FLAG) != 0 {
            let current = self
                .private_accessors
                .get(&key)
                .copied()
                .unwrap_or_default();
            self.private_accessors.insert(
                key,
                AccessorData {
                    get: if flag & XS_GETTER_FLAG != 0 {
                        Some(value)
                    } else {
                        current.get
                    },
                    set: if flag & XS_SETTER_FLAG != 0 {
                        Some(value)
                    } else {
                        current.set
                    },
                },
            );
        } else {
            self.private_values.insert(key, value);
        }
        Ok(())
    }

    pub(super) fn dispatch_get_private(&mut self, code: &[u8], index: usize) -> Result<(), Step> {
        let brand = match self.closure_cell(index) {
            Some(cell) => cell,
            None => return Err(Step::Host(Halt::NotImplemented("private:missing-brand"))),
        };
        let private_name = self.property_debug_name(
            self.locals[self.local_index(index).expect("private name binding")].id,
        );
        let receiver = self.pop();
        let object = match receiver.value {
            Payload::Reference(object) if receiver.kind == Kind::Reference => object,
            _ => {
                let error = self.internal_error(
                    "TypeError",
                    if matches!(receiver.kind, Kind::Null | Kind::Undefined) {
                        cannot_coerce_to_object(receiver.kind)
                    } else {
                        format!("get {private_name}: undefined private property")
                    },
                );
                return Err(self.raise_js(error));
            }
        };
        let key = (object, brand);
        let value = if let Some(value) = self.private_values.get(&key).copied() {
            value
        } else if let Some(accessor) = self.private_accessors.get(&key).copied() {
            match accessor.get {
                Some(getter) => (self.run_callback(code, getter, receiver, &[]))?,
                None => Slot::undefined(),
            }
        } else {
            let error = self.internal_error(
                "TypeError",
                format!("get {private_name}: undefined private property"),
            );
            return Err(self.raise_js(error));
        };
        self.push(value);
        Ok(())
    }

    pub(super) fn dispatch_set_private(&mut self, code: &[u8], index: usize) -> Result<(), Step> {
        let brand = match self.closure_cell(index) {
            Some(cell) => cell,
            None => return Err(Step::Host(Halt::NotImplemented("private:missing-brand"))),
        };
        let value = self.pop();
        let private_name = self.property_debug_name(
            self.locals[self.local_index(index).expect("private name binding")].id,
        );
        let receiver = self.pop();
        let object = match receiver.value {
            Payload::Reference(object) if receiver.kind == Kind::Reference => object,
            _ => {
                let error = self.internal_error(
                    "TypeError",
                    if matches!(receiver.kind, Kind::Null | Kind::Undefined) {
                        cannot_coerce_to_object(receiver.kind)
                    } else {
                        format!("set {private_name}: undefined private property")
                    },
                );
                return Err(self.raise_js(error));
            }
        };
        let key = (object, brand);
        if self.private_values.contains_key(&key) {
            self.private_values.insert(key, value);
        } else if let Some(accessor) = self.private_accessors.get(&key).copied() {
            match accessor.set {
                Some(setter) => {
                    let _ = (self.run_callback(code, setter, receiver, &[value]))?;
                }
                None => {
                    let error = self.internal_error(
                        "TypeError",
                        format!("set {private_name}: undefined private property"),
                    );
                    return Err(self.raise_js(error));
                }
            }
        } else {
            let error = self.internal_error(
                "TypeError",
                format!("set {private_name}: undefined private property"),
            );
            return Err(self.raise_js(error));
        }
        self.push(value);
        Ok(())
    }

    pub(super) fn dispatch_has_private(&mut self, index: usize) -> Result<(), Step> {
        let brand = match self.closure_cell(index) {
            Some(cell) => cell,
            None => return Err(Step::Host(Halt::NotImplemented("private:missing-brand"))),
        };
        let receiver = self.pop();
        let present = match receiver.value {
            Payload::Reference(object) if receiver.kind == Kind::Reference => {
                let key = (object, brand);
                self.private_values.contains_key(&key) || self.private_accessors.contains_key(&key)
            }
            _ => {
                let error = self.internal_error("TypeError", "in: not an object".into());
                return Err(self.raise_js(error));
            }
        };
        self.push(Slot::boolean(present));
        Ok(())
    }
}
