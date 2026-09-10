//! Super property opcode semantics.
//! Return transfers unchanged; only the dispatch loop owns catch resumption.
use super::super::*;

impl Interp {
    pub(super) fn dispatch_get_super(&mut self, code: &[u8], id: u16) -> Result<(), Step> {
        let receiver = self.pop();
        let home = self
            .functions
            .get(&self.cur_func)
            .map(|info| info.home)
            .unwrap_or(crate::value::SlotIndex::NULL);
        if home.is_null() {
            return Err(Step::Host(Halt::NotImplemented("get_super:no-home")));
        }
        let base = self.instance_prototype(home);
        // GetValue on a super reference performs ToObject on the
        // home prototype; a null [[Prototype]] is a TypeError
        // (ECMA-262 6.2.5.5), raised at use, after key evaluation.
        if base.is_null() {
            let error = self.internal_error(
                "TypeError",
                format!("get super.{}: no prototype", self.property_debug_name(id)),
            );
            return Err(self.raise_js(error));
        }
        let value = (self.ordinary_get(code, base, id, receiver))?;
        self.push(value);
        Ok(())
    }

    pub(super) fn dispatch_get_super_at(&mut self, code: &[u8]) -> Result<(), Step> {
        let key = self.pop();
        let super_ref = self.pop();
        let receiver_ref = match super_ref.value {
            Payload::Reference(receiver) if super_ref.kind == Kind::EnvReference => receiver,
            _ => return Err(Step::Host(Halt::EngineInvariant("get_super_at:reference"))),
        };
        // A read mints nothing: an index the key table has never
        // held stays an index (`ReadKey`).
        let read_key = match key.value {
            Payload::At(id, index) if id == crate::value::XS_NO_ID => {
                match self.index_read_key_id(index) {
                    Some(id) => ReadKey::Id(id),
                    None => ReadKey::Index(index),
                }
            }
            Payload::At(id, _) => ReadKey::Id(id),
            _ => return Err(Step::Host(Halt::EngineInvariant("get_super_at:key"))),
        };
        let receiver = Slot::of(Kind::Reference, Payload::Reference(receiver_ref));
        // A computed super reference defers the null-base
        // TypeError to GetValue (ECMA-262 6.2.5.5 via ToObject).
        // XS rejects earlier in SUPER_AT, before coercing the key,
        // and formats the prior opcode's ID. Keep this spec-ordered
        // guard bare rather than invent a corresponding XS text.
        if super_ref.next.is_null() {
            let error = self.build_error("TypeError", 0, 0);
            return Err(self.raise_js(error));
        }
        let value = (match read_key {
            ReadKey::Id(id) => self.ordinary_get(code, super_ref.next, id, receiver),
            ReadKey::Index(index) => {
                self.uninterned_index_get(code, super_ref.next, index, receiver)
            }
        })?;
        self.push(value);
        Ok(())
    }

    pub(super) fn dispatch_set_super(&mut self, code: &[u8], id: u16) -> Result<(), Step> {
        let value = self.pop();
        let receiver = self.pop();
        let home = self
            .functions
            .get(&self.cur_func)
            .map(|info| info.home)
            .unwrap_or(crate::value::SlotIndex::NULL);
        if home.is_null() {
            return Err(Step::Host(Halt::NotImplemented("set_super:no-home")));
        }
        let base = self.instance_prototype(home);
        // PutValue on a super reference performs ToObject on the
        // home prototype; a null [[Prototype]] is a TypeError
        // (ECMA-262 6.2.5.6), raised after the RHS has evaluated.
        if base.is_null() {
            let error = self.internal_error(
                "TypeError",
                format!("set super.{}: no prototype", self.property_debug_name(id)),
            );
            return Err(self.raise_js(error));
        }
        let accepted = (self.ordinary_set(code, base, id, value, receiver))?;
        if !accepted {
            return Err(self.failed_super_set_error(base, id, receiver));
        }
        self.push(value);
        Ok(())
    }

    pub(super) fn dispatch_set_super_at(&mut self, code: &[u8]) -> Result<(), Step> {
        let value = self.pop();
        let key = self.pop();
        let super_ref = self.pop();
        let receiver_ref = match super_ref.value {
            Payload::Reference(receiver) if super_ref.kind == Kind::EnvReference => receiver,
            _ => return Err(Step::Host(Halt::EngineInvariant("set_super_at:reference"))),
        };
        let id = match key.value {
            Payload::At(id, index) if id == crate::value::XS_NO_ID => {
                self.intern_key(index.to_string())?
            }
            Payload::At(id, _) => id,
            _ => return Err(Step::Host(Halt::EngineInvariant("set_super_at:key"))),
        };
        let receiver = Slot::of(Kind::Reference, Payload::Reference(receiver_ref));
        // A computed super reference defers the null-base
        // TypeError to PutValue (ECMA-262 6.2.5.6 via ToObject),
        // after both the key and the RHS have evaluated.
        // XS rejects earlier in SUPER_AT using the prior opcode's
        // ID; there is no corresponding stable diagnostic here.
        if super_ref.next.is_null() {
            let error = self.build_error("TypeError", 0, 0);
            return Err(self.raise_js(error));
        }
        let accepted = (self.ordinary_set(code, super_ref.next, id, value, receiver))?;
        if !accepted {
            return Err(self.failed_super_set_error(super_ref.next, id, receiver));
        }
        self.push(value);
        Ok(())
    }
}
