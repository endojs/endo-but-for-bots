//! VM-facing date builtin algorithms.
use super::super::*;

impl Interp {
    pub(in crate::interp) fn date_method(
        &mut self,
        op: u8,
        this: Slot,
        base: usize,
        argc: usize,
        code: &[u8],
    ) -> Result<Slot, Step> {
        let arg = |stack: &[Slot], i: usize| {
            stack
                .get(base + 4 + i)
                .copied()
                .unwrap_or_else(Slot::undefined)
        };
        match op {
            0 => {
                let units = self.to_string_units(code, arg(&self.stack, 0))?;
                let parsed = String::from_utf16(&units)
                    .ok()
                    .as_deref()
                    .and_then(parse_date_string);
                Ok(Slot::number(parsed.unwrap_or(f64::NAN)))
            }
            1 => {
                let inputs: Vec<Slot> = (0..7)
                    .map(|i| {
                        if i < argc {
                            arg(&self.stack, i)
                        } else if i == 0 {
                            // `year` is the sole required argument. Its absent
                            // value is `undefined`, so ToNumber produces NaN.
                            Slot::undefined()
                        } else if i == 2 {
                            Slot::integer(1)
                        } else {
                            Slot::integer(0)
                        }
                    })
                    .collect();
                let mut values = [0.0; 7];
                for (value, input) in values.iter_mut().zip(inputs) {
                    *value = self.to_number_f64(code, input)?;
                }
                Ok(Slot::number(date_from_components(values)))
            }
            2 => Ok(Slot::number(0.0)),
            _ => {
                if op == 27 {
                    // Date.prototype.toJSON is intentionally generic:
                    // ToObject, ToPrimitive(number), the non-finite Number
                    // shortcut, then Invoke(O, "toISOString").
                    let object = self.array_to_object(this)?;
                    let primitive = self.to_primitive(code, object, false)?;
                    if primitive.kind == Kind::Number && !to_number(&primitive).is_finite() {
                        return Ok(Slot::null());
                    }
                    let Payload::Reference(inst) = object.value else {
                        unreachable!("ToObject result")
                    };
                    let id = self
                        .symbol_ids
                        .get("toISOString")
                        .copied()
                        .ok_or(Step::Host(Halt::EngineInvariant(
                            "Date.toJSON:toISOString-key",
                        )))?;
                    let method = self.mop_get(code, inst, id, object)?;
                    return self.invoke_value(code, method, object, &[]);
                }
                let inst = match this.value {
                    Payload::Reference(r) if self.dates.contains_key(&r) => r,
                    _ => {
                        return Err(
                            self.catchable_type_error_msg("this: not a Date instance".into())
                        )
                    }
                };
                let t = self.dates[&inst];
                if op == 26 {
                    if self.slots.get(inst).flag & XS_DONT_MODIFY_FLAG != 0 {
                        return Err(
                            self.catchable_type_error_msg("this: read-only Date instance".into())
                        );
                    }
                    let clipped = time_clip(self.to_number_f64(code, arg(&self.stack, 0))?);
                    self.dates.insert(inst, clipped);
                    return Ok(Slot::number(clipped));
                }
                if (28..=34).contains(&op) {
                    let arity = match op {
                        28 | 32 => 1,
                        29 | 33 => 2,
                        30 | 34 => 3,
                        31 => 4,
                        _ => unreachable!(),
                    };
                    // Every setter has one required argument: an omitted first
                    // argument is still `undefined` and therefore becomes NaN.
                    // Optional arguments are coerced only when present, in
                    // left-to-right order, before the Date value is changed.
                    let count = argc.max(1).min(arity);
                    let mut inputs = self.reserve_scratch(count)?;
                    for i in 0..count {
                        inputs.push(self.to_number_f64(code, arg(&self.stack, i))?);
                    }
                    if self.slots.get(inst).flag & XS_DONT_MODIFY_FLAG != 0 {
                        return Err(
                            self.catchable_type_error_msg("this: read-only Date instance".into())
                        );
                    }
                    // SetFullYear alone recovers an invalid Date from +0. Every
                    // other setter preserves NaN after performing the required
                    // argument coercions above.
                    let base_t = if t.is_finite() {
                        t
                    } else if op == 34 {
                        0.0
                    } else {
                        self.dates.insert(inst, f64::NAN);
                        return Ok(Slot::number(f64::NAN));
                    };
                    let (year, month, day, _, hour, minute, second, millis) =
                        civil_fields(base_t, 0);
                    let mut components = [
                        year as f64,
                        month as f64 - 1.0,
                        day as f64,
                        hour as f64,
                        minute as f64,
                        second as f64,
                        millis as f64,
                    ];
                    match op {
                        28 => components[6] = inputs[0],
                        29 => {
                            components[5] = inputs[0];
                            if inputs.len() > 1 {
                                components[6] = inputs[1];
                            }
                        }
                        30 => {
                            components[4] = inputs[0];
                            if inputs.len() > 1 {
                                components[5] = inputs[1];
                            }
                            if inputs.len() > 2 {
                                components[6] = inputs[2];
                            }
                        }
                        31 => {
                            components[3] = inputs[0];
                            if inputs.len() > 1 {
                                components[4] = inputs[1];
                            }
                            if inputs.len() > 2 {
                                components[5] = inputs[2];
                            }
                            if inputs.len() > 3 {
                                components[6] = inputs[3];
                            }
                        }
                        32 => components[2] = inputs[0],
                        33 => {
                            components[1] = inputs[0];
                            if inputs.len() > 1 {
                                components[2] = inputs[1];
                            }
                        }
                        34 => {
                            components[0] = inputs[0];
                            if inputs.len() > 1 {
                                components[1] = inputs[1];
                            }
                            if inputs.len() > 2 {
                                components[2] = inputs[2];
                            }
                        }
                        _ => unreachable!(),
                    }
                    let clipped = date_from_components_exact(components);
                    self.dates.insert(inst, clipped);
                    return Ok(Slot::number(clipped));
                }
                if matches!(op, 10 | 11) {
                    return Ok(Slot::number(t));
                }
                if !t.is_finite() {
                    return match op {
                        21 => Err(self.catchable_range_error_msg("Invalid Date".into())),
                        22..=25 => Ok(self.intl_string("Invalid Date")),
                        _ => Ok(Slot::number(f64::NAN)),
                    };
                }
                let (year, month, day, weekday, hour, minute, second, millis) = civil_fields(t, 0);
                Ok(match op {
                    12 => Slot::number(year as f64),
                    13 => Slot::integer(month as i32 - 1),
                    14 => Slot::integer(day as i32),
                    15 => Slot::integer(weekday as i32),
                    16 => Slot::integer(hour as i32),
                    17 => Slot::integer(minute as i32),
                    18 => Slot::integer(second as i32),
                    19 => Slot::integer(millis as i32),
                    20 => Slot::integer(0),
                    21 => self.intl_string(&date_iso_string(t)),
                    22 => self.intl_string(&date_utc_string(t)),
                    23 => self.intl_string(&date_local_string(t)),
                    24 => self.intl_string(&date_only_string(t)),
                    25 => self.intl_string(&date_time_string(t)),
                    _ => return Err(Step::Host(Halt::NotImplemented("Date:method"))),
                })
            }
        }
    }
}
