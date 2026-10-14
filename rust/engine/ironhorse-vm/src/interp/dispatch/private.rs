//! Private opcode semantics.
//! Return transfers unchanged; only the dispatch loop owns catch resumption.
use super::super::*;

impl Interp {
    pub(super) fn dispatch_new_private(&mut self, index: usize, flag: u8) -> Result<(), Step> {
        let brand = match self.closure_cell(index) {
            Some(cell) => cell,
            None => return Err(Step::Host(Halt::NotImplemented("private:missing-brand"))),
        };
        let value = self.pop_checked()?;
        let receiver = self.pop_checked()?;
        let object = match receiver.value {
            Payload::Reference(object) if receiver.kind == Kind::Reference => object,
            _ => {
                // Valid compiled private initialization always has an
                // instance receiver; this guards malformed VM input.
                let error = self.internal_error(
                    "TypeError",
                    "private initialization: receiver must be an object".into(),
                );
                return Err(self.raise_js(error));
            }
        };

        let key = (object, brand);
        // PrivateFieldAdd and PrivateMethodOrAccessorAdd throw when the
        // element is already there, so a constructor that returns an existing
        // object cannot reinitialize its private state. Only the other half
        // of an accessor pair may follow its first half (`fxDefinePrivateProperty`).
        let accessor = self.private_accessors.get(&key).copied();
        let present = if flag & (XS_GETTER_FLAG | XS_SETTER_FLAG) != 0 {
            self.private_values.contains_key(&key)
                || accessor.is_some_and(|accessor| {
                    if flag & XS_GETTER_FLAG != 0 {
                        accessor.get.is_some()
                    } else {
                        accessor.set.is_some()
                    }
                })
        } else {
            self.private_values.contains_key(&key) || accessor.is_some()
        };
        if present {
            let private_name = self.property_debug_name(
                self.locals[self.local_index(index).expect("private name binding")].id,
            );
            let error = self.internal_error("TypeError", format!("set {private_name}: const"));
            return Err(self.raise_js(error));
        }
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
            // A private method is not writable; the stored flag says which
            // elements are methods, as XS's does, and survives a snapshot.
            let mut value = value;
            value.flag = if flag & XS_METHOD_FLAG != 0 {
                XS_DONT_SET_FLAG
            } else {
                0
            };
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
        let receiver = self.pop_checked()?;
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
        let value = if let Some(mut value) = self.private_values.get(&key).copied() {
            value.flag = 0;
            value
        } else if let Some(getter) = self
            .private_accessors
            .get(&key)
            .copied()
            .and_then(|accessor| accessor.get)
        {
            (self.run_callback(code, getter, receiver, &[]))?
        } else {
            // Absent, or an accessor with no getter (PrivateGet step 5).
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
        let value = self.pop_checked()?;
        let private_name = self.property_debug_name(
            self.locals[self.local_index(index).expect("private name binding")].id,
        );
        let receiver = self.pop_checked()?;
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
        if let Some(current) = self.private_values.get(&key).copied() {
            // PrivateSet step 4: a method cannot be assigned.
            if current.flag & XS_DONT_SET_FLAG != 0 {
                let error =
                    self.internal_error("TypeError", format!("set {private_name}: not writable"));
                return Err(self.raise_js(error));
            }
            let mut value = value;
            value.flag = 0;
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
        let receiver = self.pop_checked()?;
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
