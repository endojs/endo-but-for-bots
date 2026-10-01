//! The coder's walk: `code`, `code_this` and the arms that form chains or
//! nests, as one loop over an explicit continuation stack
//! (STACK-DEPTH-REFACTOR.md §4.6 D2).
//!
//! A member, call, logical, conditional, `if`, unary, binary or assignment
//! chain nests one tree level per link, and the parser bounds those links only
//! by [`crate::ast::TREE_DEPTH_LIMIT`], so coding them recursively took one
//! group of host frames per link: a 2,043-link tagged-template chain needed
//! 788 KB of native stack to compile. Functions, their bodies and hoisted
//! declarations, blocks, statements, `yield` and `await` nest too, within the
//! parser's budget. Here each such arm is split at the points where it codes a
//! child. The part before the child runs when the node is entered; the
//! rest waits on the [`Resume`] stack until the child is coded. So the arms
//! make the same calls in the same order (every `add_*`, `create_target`,
//! `use_temporary`, `generate_tag`, work charge and depth check), and the walk
//! takes a heap entry per suspended arm instead of host frames.
//!
//! Every other arm still runs as a function ([`Coder::code_arm`]) that codes
//! its children through [`Coder::code`], which starts a new walk: those nest
//! only as deep as the parser's nesting budget allows.

use super::*;

/// What the walk does next.
#[derive(Clone, Copy)]
enum Step<'n> {
    /// `fxNodeDispatchCode` for one child slot.
    Code(&'n Item),
    /// Enter one node: the work charge, the depth check and the depth, then
    /// take the staged no-value and tail flags and start its arm.
    Node(&'n Node),
    /// `fxNodeDispatchCodeThis`: code a callee reference in receiver-setup
    /// mode, leaving the residual flag as the walk's result.
    This(&'n Item, i32),
    /// Resume the innermost suspended arm.
    Up,
}

/// An arm suspended while one of its children is coded: what it does once
/// that child is.
enum Resume<'n> {
    /// The exit of a node entered in place: release its level.
    Leave,
    /// `fxNodeCodeThis`: its residual flag, once the value is coded.
    ThisResult(i32),
    /// `fxStatementsNodeCode`: the next statement.
    Statements(&'n [Item], usize),
    /// `fxStatementNodeCode` at program level: set the result.
    StatementProgram,
    /// `fxStatementNodeCode` in a body: discard the value.
    StatementBody,
    /// `fxScopeCodeDefineNodes` for a block (or a function body, when
    /// `body`): code the next hoisted function declaration among its
    /// statements from `i`, then open its disposal region, if any, and code
    /// the statements.
    Defines {
        node: &'n Node,
        scope: usize,
        i: usize,
        body: bool,
    },
    /// `fxDefineNodeCode`, after the initializer: store and pop.
    Define(&'n Node),
    /// `fxBlockNodeCode`: close the disposal region, if any, and the scope.
    Block {
        scope: usize,
        using: Option<(i32, i32, usize)>,
    },
    /// `fxBodyNodeCode`: close the disposal region, if any, and the body.
    Body {
        scope: usize,
        using: Option<(i32, i32, usize)>,
    },
    /// `fxFunctionNodeCode`, after the parameters. Boxed, so that every
    /// suspended arm stays small.
    FunctionParams(&'n Node, Box<FunctionCode>),
    /// `fxFunctionNodeCode`, after the body.
    FunctionBody(&'n Node, Box<FunctionCode>),
    /// `fxIfNodeCode`, after the test.
    IfTest(&'n Node),
    /// `fxIfNodeCode`, after the consequent.
    IfThen {
        node: &'n Node,
        program: bool,
        else_target: Option<usize>,
        end_target: usize,
    },
    /// Place an end target (`if`, `&&`, `||`, `??`, `?:`).
    End(usize),
    /// `fxUnaryExpressionNodeCode`: the operator.
    Unary(Token),
    /// `fxBinaryExpressionNodeCode`, after the left operand.
    BinaryRight(&'n Node),
    /// `fxBinaryExpressionNodeCode`, after the right operand.
    BinaryOp(Token),
    /// `&&`, `||` and `??`, after the left operand.
    Logical {
        node: &'n Node,
        end_target: usize,
        tail: bool,
    },
    /// `fxQuestionMarkNodeCode`, after the test.
    QuestionTest {
        node: &'n Node,
        else_target: usize,
        end_target: usize,
        tail: bool,
    },
    /// `fxQuestionMarkNodeCode`, after the consequent.
    QuestionThen {
        node: &'n Node,
        else_target: usize,
        end_target: usize,
        tail: bool,
    },
    /// `fxChainNodeCode`: place the short-circuit target, restore the outer.
    Chain { target: usize, saved: Option<usize> },
    /// `fxOptionNodeCode`: branch to the chain's target.
    Option,
    /// `fxMemberNodeCode`, after the object.
    Member(&'n Node),
    /// `fxPrivateMemberNodeCode`, after the reference.
    PrivateMember(&'n Node),
    /// `fxMemberAtNodeCode`, after the object (`second` false) or the key.
    MemberAt {
        node: &'n Node,
        is_super: bool,
        second: bool,
    },
    /// `fxCallNodeCode`, after the callee and its receiver.
    Call {
        node: &'n Node,
        is_eval: bool,
        tail: bool,
    },
    /// `fxTemplateNodeCode`'s tagged branch, after the tag and its receiver.
    Tagged {
        items: &'n [Item],
        tail: bool,
        cache_target: usize,
        string_count: i32,
        raws: i32,
        strings: i32,
    },
    /// `fxAssignNodeCode`, after the value.
    Assign(&'n Node),
    /// `fxCompoundExpressionNodeCode`, after the reference: its residual
    /// flag is the walk's result, which every receiver-setup arm sets as its
    /// last action (where the recursion read a fresh `code_this` return).
    CompoundReference {
        node: &'n Node,
        no_value: bool,
        shortcut: Option<(usize, usize)>,
    },
    /// `fxCompoundExpressionNodeCode`, after the value.
    CompoundValue {
        node: &'n Node,
        no_value: bool,
        shortcut: Option<(usize, usize)>,
        swap: i32,
    },
    /// `fxYieldNodeCode`, after the operand.
    Yield(&'n Node, usize),
    /// `fxAwaitNodeCode`, after the operand.
    Await(&'n Node, usize),
    /// `fxMemberNodeCodeThis`, after the object.
    MemberThis(&'n Node),
    /// `fxPrivateMemberNodeCodeThis`, after the reference.
    PrivateMemberThis(&'n Node),
    /// `fxMemberAtNodeCodeThis`, after the object (`second` false) or the key.
    MemberAtThis {
        node: &'n Node,
        is_super: bool,
        flag: i32,
        second: bool,
    },
    /// `fxChainNodeCodeThis`: place the target, restore the outer one.
    ChainThis { target: usize, saved: Option<usize> },
    /// `fxOptionNodeCodeThis`: drop the receiver of a nullish base.
    OptionThis {
        swap_target: usize,
        skip_target: usize,
    },
}

impl Coder<'_, '_> {
    /// Code `node`, which `code_node` has entered, if its arm is one the walk
    /// runs; `false` for every other arm, having done nothing. Out of line,
    /// so that the other arms, which recurse through `code`, never carry the
    /// walk's frame.
    #[inline(never)]
    pub(super) fn walk(&mut self, node: &Node, no_value: bool, tail: bool) -> bool {
        let mut stack: Vec<Resume<'_>> = Vec::new();
        match self.enter(node, no_value, tail, &mut stack) {
            Some(first) => {
                self.run(first, stack);
                true
            }
            None => false,
        }
    }

    /// `fxNodeDispatchCodeThis`: code a callee reference in receiver-setup
    /// mode, returning the residual flag.
    #[inline(never)]
    pub(super) fn walk_this(&mut self, item: &Item, flag: i32) -> i32 {
        self.run(Step::This(item, flag), Vec::new())
    }

    /// Run the walk from `first` until `stack` is empty, returning the
    /// residual flag the outermost receiver-setup arm leaves. Inlined into
    /// both entries, so that an arm the walk does not run, recursing through
    /// `code`, carries one walk frame per level rather than two.
    #[inline(always)]
    fn run<'n>(&mut self, first: Step<'n>, mut stack: Vec<Resume<'n>>) -> i32 {
        let mut result = 0;
        let mut step = first;
        loop {
            step = match step {
                Step::Code(item) => match item {
                    Item::Node(node) => Step::Node(node),
                    Item::Null => Step::Up,
                    other => panic!("unexpected item in coder: {:?}", other),
                },
                Step::Node(node) => {
                    // `code_node`'s entry, in place.
                    self.meter.work(1);
                    if self.depth >= crate::ast::TREE_DEPTH_LIMIT {
                        self.report(node.line, "stack overflow");
                    }
                    self.depth += 1;
                    let no_value = std::mem::take(&mut self.no_value);
                    let tail = std::mem::take(&mut self.tail);
                    let mark = stack.len();
                    stack.push(Resume::Leave);
                    match self.enter(node, no_value, tail, &mut stack) {
                        Some(next) => next,
                        None => {
                            stack.truncate(mark);
                            self.code_arm(node, no_value, tail);
                            self.depth -= 1;
                            Step::Up
                        }
                    }
                }
                Step::This(item, flag) => self.enter_this(item, flag, &mut stack, &mut result),
                Step::Up => match stack.pop() {
                    None => return result,
                    Some(resume) => self.resume(resume, &mut stack, &mut result),
                },
            };
        }
    }

    /// Start the arm of a node just entered, if it is one the walk runs: do
    /// what the arm does before its first child, push the arm's [`Resume`],
    /// and return the step for that child (or [`Step::Up`] for a define
    /// already coded, which pushes nothing). `None` for every other arm,
    /// having done nothing.
    #[inline(never)]
    fn enter<'n>(
        &mut self,
        node: &'n Node,
        no_value: bool,
        tail: bool,
        stack: &mut Vec<Resume<'n>>,
    ) -> Option<Step<'n>> {
        use Token::*;
        let (resume, next) = match node.token {
            Statements => {
                let items: &[Item] = match node.children.first() {
                    Some(Item::List(items)) => items,
                    _ => &[],
                };
                (Resume::Statements(items, 0), Step::Up)
            }
            Statement => {
                if self.program_flag {
                    (Resume::StatementProgram, Step::Code(&node.children[0]))
                } else {
                    // `self->expression->flags |= mxExpressionNoValue`.
                    self.no_value = true;
                    (Resume::StatementBody, Step::Code(&node.children[0]))
                }
            }
            Block => {
                let scope = self.scope_of(node);
                self.scope_coding_block(scope);
                (
                    Resume::Defines {
                        node,
                        scope,
                        i: 0,
                        body: false,
                    },
                    Step::Up,
                )
            }
            Body => {
                let scope = self.code_body_open(node);
                (
                    Resume::Defines {
                        node,
                        scope,
                        i: 0,
                        body: true,
                    },
                    Step::Up,
                )
            }
            Function | Generator => {
                let function = Box::new(self.code_function_open(node));
                (
                    Resume::FunctionParams(node, function),
                    Step::Code(&node.children[1]),
                )
            }
            Define => {
                if !self.code_define_open(node) {
                    // Coded where its scope hoisted it.
                    return Some(Step::Up);
                }
                (Resume::Define(node), Step::Code(&node.children[1]))
            }
            If => (Resume::IfTest(node), Step::Code(&node.children[0])),
            Void | Not | BitNot | Minus | Plus | Typeof => {
                (Resume::Unary(node.token), Step::Code(&node.children[0]))
            }
            Add | Subtract | Multiply | Divide | Modulo | Exponentiation | BitAnd | BitOr
            | BitXor | LeftShift | SignedRightShift | UnsignedRightShift | Equal | NotEqual
            | StrictEqual | StrictNotEqual | Less | LessEqual | More | MoreEqual | Instanceof
            | In => (Resume::BinaryRight(node), Step::Code(&node.children[0])),
            And | Or | Coalesce => {
                let end_target = self.create_target();
                (
                    Resume::Logical {
                        node,
                        end_target,
                        tail,
                    },
                    Step::Code(&node.children[0]),
                )
            }
            QuestionMark => {
                let else_target = self.create_target();
                let end_target = self.create_target();
                (
                    Resume::QuestionTest {
                        node,
                        else_target,
                        end_target,
                        tail,
                    },
                    Step::Code(&node.children[0]),
                )
            }
            Template => {
                let items = match &node.children[1] {
                    Item::List(v) => v,
                    _ => panic!("template without items list"),
                };
                if matches!(node.children[0], Item::Null) {
                    // Untagged: its substitutions are separate expressions.
                    return None;
                }
                let cache_target = self.create_target();
                // The cooked/raw arrays are sized by the number of
                // `TemplateMiddle` items, which the rest of the arm then
                // fills one index at a time. Under the parser's alternation
                // that is `(items.len() / 2) + 1`, but deriving it that way
                // makes the size rest on a shape this arm cannot see;
                // counting the items it is about to write keeps the two in
                // step by construction (F063).
                let string_count = items
                    .iter()
                    .filter(|item| node_of(item).token == Token::TemplateMiddle)
                    .count() as i32;
                let raws = self.use_temporary();
                let strings = self.use_temporary();
                (
                    Resume::Tagged {
                        items,
                        tail,
                        cache_target,
                        string_count,
                        raws,
                        strings,
                    },
                    Step::This(&node.children[0], 0),
                )
            }
            Chain => {
                // The saved outer chain target is restored: chains can nest
                // through call arguments.
                let saved = self.chain_target;
                let target = self.create_target();
                self.chain_target = Some(target);
                (
                    Resume::Chain { target, saved },
                    Step::Code(&node.children[0]),
                )
            }
            Option => {
                self.tail = tail;
                (Resume::Option, Step::Code(&node.children[0]))
            }
            Member => (Resume::Member(node), Step::Code(&node.children[0])),
            PrivateMember => (Resume::PrivateMember(node), Step::Code(&node.children[1])),
            MemberAt => {
                let is_super = self.node_is_super(&node.children[0]);
                (
                    Resume::MemberAt {
                        node,
                        is_super,
                        second: false,
                    },
                    Step::Code(&node.children[0]),
                )
            }
            Call => {
                // A syntactic `eval(...)` call (the callee is the identifier
                // `eval`: XS keys on the name, not resolution) closes with
                // the `EVAL` intrinsic instead of `RUN`; the scoper has
                // already poisoned the surrounding scopes.
                let is_eval = Self::is_direct_eval(&node.children[0]);
                (
                    Resume::Call {
                        node,
                        is_eval,
                        tail,
                    },
                    Step::This(&node.children[0], 0),
                )
            }
            Assign => {
                // Name inference: `x = function(){}` names the anonymous
                // value `x`.
                self.set_pending_name(&node.children[0], &node.children[1]);
                self.code_reference(&node.children[0], 1);
                (Resume::Assign(node), Step::Code(&node.children[1]))
            }
            AddAssign
            | SubtractAssign
            | MultiplyAssign
            | DivideAssign
            | ModuloAssign
            | ExponentiationAssign
            | BitAndAssign
            | BitOrAssign
            | BitXorAssign
            | LeftShiftAssign
            | SignedRightShiftAssign
            | UnsignedRightShiftAssign
            | AndAssign
            | OrAssign
            | CoalesceAssign => {
                let shortcut = self.code_compound_open(node);
                (
                    Resume::CompoundReference {
                        node,
                        no_value,
                        shortcut,
                    },
                    Step::This(&node.children[0], 1),
                )
            }
            Yield => {
                let target = self.code_yield_open(node);
                (Resume::Yield(node, target), Step::Code(&node.children[0]))
            }
            Await => {
                let target = self.create_target();
                (Resume::Await(node, target), Step::Code(&node.children[0]))
            }
            _ => return None,
        };
        stack.push(resume);
        Some(next)
    }

    /// `fxNodeDispatchCodeThis`: start the receiver-setup arm for `item`.
    #[inline(never)]
    fn enter_this<'n>(
        &mut self,
        item: &'n Item,
        flag: i32,
        stack: &mut Vec<Resume<'n>>,
        result: &mut i32,
    ) -> Step<'n> {
        let node = match item {
            Item::Node(node) => node,
            _ => return self.enter_node_this(item, stack),
        };
        match node.token {
            Token::Access => {
                *result = self.code_access_this(node, flag);
                Step::Up
            }
            Token::Member => {
                stack.push(Resume::MemberThis(node));
                Step::Code(&node.children[0])
            }
            Token::PrivateMember => {
                stack.push(Resume::PrivateMemberThis(node));
                Step::Code(&node.children[1])
            }
            Token::MemberAt => {
                let is_super = self.node_is_super(&node.children[0]);
                stack.push(Resume::MemberAtThis {
                    node,
                    is_super,
                    flag,
                    second: false,
                });
                Step::Code(&node.children[0])
            }
            // `fxExpressionsNodeCodeThis`: a single-item sequence forwards to
            // its item; otherwise the fallback, dispatched on the original
            // node so scope keying stays intact.
            Token::Expressions => match node.children.first() {
                Some(Item::List(items)) if items.len() == 1 => Step::This(&items[0], flag),
                _ => {
                    self.add_byte(1, XS_CODE_UNDEFINED);
                    stack.push(Resume::ThisResult(1));
                    Step::Node(node)
                }
            },
            // An optional call (`fn?.(…)`, `a?.b()`): the callee is a
            // `Chain`/`Option` in call-reference position, so it must code
            // the `this`/value pair and short-circuit the whole chain when a
            // base is nullish, not fall through to the plain-value fallback
            // (which would drop the receiver dance).
            Token::Chain => {
                let saved = self.chain_target;
                let target = self.create_target();
                self.chain_target = Some(target);
                stack.push(Resume::ChainThis { target, saved });
                Step::This(&node.children[0], flag)
            }
            Token::Option => {
                let swap_target = self.create_target();
                let skip_target = self.create_target();
                stack.push(Resume::OptionThis {
                    swap_target,
                    skip_target,
                });
                Step::This(&node.children[0], flag)
            }
            _ => self.enter_node_this(item, stack),
        }
    }

    /// `fxNodeCodeThis`, the fallback: push `undefined` as the receiver, then
    /// the value.
    fn enter_node_this<'n>(&mut self, item: &'n Item, stack: &mut Vec<Resume<'n>>) -> Step<'n> {
        self.add_byte(1, XS_CODE_UNDEFINED);
        stack.push(Resume::ThisResult(1));
        Step::Code(item)
    }

    /// Continue a suspended arm now that the child it waited on is coded.
    #[inline(never)]
    fn resume<'n>(
        &mut self,
        resume: Resume<'n>,
        stack: &mut Vec<Resume<'n>>,
        result: &mut i32,
    ) -> Step<'n> {
        match resume {
            Resume::Leave => {
                self.depth -= 1;
                Step::Up
            }
            Resume::ThisResult(flag) => {
                *result = flag;
                Step::Up
            }
            Resume::Statements(items, i) => match items.get(i) {
                Some(item) => {
                    stack.push(Resume::Statements(items, i + 1));
                    Step::Code(item)
                }
                None => Step::Up,
            },
            Resume::StatementProgram => {
                self.add_byte(-1, XS_CODE_SET_RESULT);
                Step::Up
            }
            Resume::StatementBody => {
                // A trailing `SET_LOCAL`/`SET_CLOSURE` is rewritten in place
                // to the fused `PULL_LOCAL`/`PULL_CLOSURE` (store-and-pop).
                match self.codes.last().map(|c| c.id) {
                    Some(XS_CODE_SET_CLOSURE_1) => self.fuse_pull(XS_CODE_PULL_CLOSURE_1),
                    Some(XS_CODE_SET_LOCAL_1) => self.fuse_pull(XS_CODE_PULL_LOCAL_1),
                    _ => self.add_byte(-1, XS_CODE_POP),
                }
                Step::Up
            }
            Resume::Defines {
                node,
                scope,
                i,
                body,
            } => {
                let items = Self::statement_items(&node.children[0]);
                for (j, item) in items.iter().enumerate().skip(i) {
                    let Item::Node(n) = item else { continue };
                    if n.token != Token::Define || !self.code_define_open(n) {
                        continue;
                    }
                    stack.push(Resume::Defines {
                        node,
                        scope,
                        i: j + 1,
                        body,
                    });
                    stack.push(Resume::Define(n));
                    return Step::Code(&n.children[1]);
                }
                // `fxScopeCodeUsingStatement` with no disposables is just
                // the statement dispatch.
                let using = if self.tree.scopes[scope].disposable_count > 0 {
                    Some(self.scope_code_using(scope))
                } else {
                    None
                };
                stack.push(if body {
                    Resume::Body { scope, using }
                } else {
                    Resume::Block { scope, using }
                });
                Step::Code(&node.children[0])
            }
            Resume::Define(node) => {
                self.code_define_close(node);
                Step::Up
            }
            Resume::Block { scope, using } => {
                if let Some(context) = using {
                    self.scope_code_used(scope, context);
                }
                self.scope_coded(scope);
                Step::Up
            }
            Resume::Body { scope, using } => {
                if let Some(context) = using {
                    self.scope_code_used(scope, context);
                }
                self.code_body_close(scope);
                Step::Up
            }
            Resume::FunctionParams(node, function) => {
                self.code_function_params_coded(node, &function);
                stack.push(Resume::FunctionBody(node, function));
                Step::Code(&node.children[2])
            }
            Resume::FunctionBody(node, function) => {
                self.code_function_close(node, *function);
                Step::Up
            }
            Resume::IfTest(node) => {
                // The program-flag branch: each arm sets the result to
                // `undefined` first, per XS.
                let program = self.program_flag;
                let has_else = !matches!(node.children[2], Item::Null);
                let else_target = if program || has_else {
                    Some(self.create_target())
                } else {
                    None
                };
                let end_target = self.create_target();
                self.add_branch(-1, XS_CODE_BRANCH_ELSE_1, else_target.unwrap_or(end_target));
                if program {
                    self.add_byte(1, XS_CODE_UNDEFINED);
                    self.add_byte(-1, XS_CODE_SET_RESULT);
                }
                stack.push(Resume::IfThen {
                    node,
                    program,
                    else_target,
                    end_target,
                });
                Step::Code(&node.children[1])
            }
            Resume::IfThen {
                node,
                program,
                else_target,
                end_target,
            } => {
                let Some(else_target) = else_target else {
                    self.place_target(0, end_target);
                    return Step::Up;
                };
                self.add_branch(0, XS_CODE_BRANCH_1, end_target);
                self.place_target(0, else_target);
                if program {
                    self.add_byte(1, XS_CODE_UNDEFINED);
                    self.add_byte(-1, XS_CODE_SET_RESULT);
                }
                if matches!(node.children[2], Item::Null) {
                    self.place_target(0, end_target);
                    return Step::Up;
                }
                stack.push(Resume::End(end_target));
                Step::Code(&node.children[2])
            }
            Resume::End(target) => {
                self.place_target(0, target);
                Step::Up
            }
            Resume::Unary(token) => {
                self.add_byte(0, unary_code(token));
                Step::Up
            }
            Resume::BinaryRight(node) => {
                stack.push(Resume::BinaryOp(node.token));
                Step::Code(&node.children[1])
            }
            Resume::BinaryOp(token) => {
                self.add_byte(-1, binary_code(token));
                Step::Up
            }
            Resume::Logical {
                node,
                end_target,
                tail,
            } => {
                match node.token {
                    Token::And => {
                        self.add_byte(1, XS_CODE_DUB);
                        self.add_branch(-1, XS_CODE_BRANCH_ELSE_1, end_target);
                        self.add_byte(-1, XS_CODE_POP);
                    }
                    Token::Or => {
                        self.add_byte(1, XS_CODE_DUB);
                        self.add_branch(-1, XS_CODE_BRANCH_IF_1, end_target);
                        self.add_byte(-1, XS_CODE_POP);
                    }
                    Token::Coalesce => self.add_branch(-1, XS_CODE_BRANCH_COALESCE_1, end_target),
                    other => unreachable!("not a logical operator: {:?}", other),
                }
                // `a && b()`: the right operand is the tail-position value.
                self.tail = tail;
                stack.push(Resume::End(end_target));
                Step::Code(&node.children[1])
            }
            Resume::QuestionTest {
                node,
                else_target,
                end_target,
                tail,
            } => {
                self.add_branch(-1, XS_CODE_BRANCH_ELSE_1, else_target);
                // Both arms are tail-position values (`return c ? f() : g()`).
                self.tail = tail;
                stack.push(Resume::QuestionThen {
                    node,
                    else_target,
                    end_target,
                    tail,
                });
                Step::Code(&node.children[1])
            }
            Resume::QuestionThen {
                node,
                else_target,
                end_target,
                tail,
            } => {
                self.add_branch(0, XS_CODE_BRANCH_1, end_target);
                self.place_target(-1, else_target);
                self.tail = tail;
                stack.push(Resume::End(end_target));
                Step::Code(&node.children[2])
            }
            Resume::Chain { target, saved } => {
                self.place_target(0, target);
                self.chain_target = saved;
                Step::Up
            }
            Resume::Option => {
                let target = self.chain_target.expect("optional `?.` outside a chain");
                self.add_branch(0, XS_CODE_BRANCH_CHAIN_1, target);
                Step::Up
            }
            Resume::Member(node) => {
                let is_super = self.node_is_super(&node.children[0]);
                let name = Self::symbol_of(&node.children[1]);
                let op = if is_super {
                    XS_CODE_GET_SUPER
                } else {
                    XS_CODE_GET_PROPERTY
                };
                self.add_symbol(0, op, &name);
                Step::Up
            }
            Resume::PrivateMember(node) => {
                let index = self.private_index(node);
                self.add_index(0, XS_CODE_GET_PRIVATE_1, index);
                Step::Up
            }
            Resume::MemberAt {
                node,
                is_super,
                second: false,
            } => {
                stack.push(Resume::MemberAt {
                    node,
                    is_super,
                    second: true,
                });
                Step::Code(&node.children[1])
            }
            Resume::MemberAt { is_super, .. } => {
                self.add_byte(
                    0,
                    if is_super {
                        XS_CODE_SUPER_AT
                    } else {
                        XS_CODE_AT
                    },
                );
                self.add_byte(
                    -1,
                    if is_super {
                        XS_CODE_GET_SUPER_AT
                    } else {
                        XS_CODE_GET_PROPERTY_AT
                    },
                );
                Step::Up
            }
            Resume::Call {
                node,
                is_eval,
                tail,
            } => {
                self.add_byte(1, XS_CODE_CALL);
                // XS: `fxCallNodeCode` relays the tail-recursion flag to the
                // params node, whose `RUN` / `EVAL` becomes the `RUN_TAIL` /
                // `EVAL_TAIL` variant. The callee reference was coded out of
                // tail position.
                self.code_params(node_of(&node.children[1]), is_eval, tail);
                Step::Up
            }
            Resume::Tagged {
                items,
                tail,
                cache_target,
                string_count,
                raws,
                strings,
            } => {
                self.code_tagged_template(items, tail, cache_target, string_count, raws, strings);
                Step::Up
            }
            Resume::Assign(node) => {
                self.code_assign(&node.children[0], 1);
                Step::Up
            }
            Resume::CompoundReference {
                node,
                no_value,
                shortcut,
            } => {
                self.code_compound_reference_coded(node, shortcut);
                stack.push(Resume::CompoundValue {
                    node,
                    no_value,
                    shortcut,
                    swap: *result,
                });
                Step::Code(&node.children[1])
            }
            Resume::CompoundValue {
                node,
                no_value,
                shortcut,
                swap,
            } => {
                self.code_compound_close(node, no_value, shortcut, swap);
                Step::Up
            }
            Resume::Yield(node, target) => {
                self.code_yield_close(node, target);
                Step::Up
            }
            Resume::Await(node, target) => {
                self.code_await_close(node, target);
                Step::Up
            }
            Resume::MemberThis(node) => {
                // The object is the receiver (`DUB`'d).
                let is_super = self.node_is_super(&node.children[0]);
                let name = Self::symbol_of(&node.children[1]);
                self.add_byte(1, XS_CODE_DUB);
                self.add_symbol(
                    0,
                    if is_super {
                        XS_CODE_GET_SUPER
                    } else {
                        XS_CODE_GET_PROPERTY
                    },
                    &name,
                );
                *result = 1;
                Step::Up
            }
            Resume::PrivateMemberThis(node) => {
                // `obj.#m(...)`: the object is the receiver (`DUB`'d), then
                // the private value is read by brand.
                self.add_byte(1, XS_CODE_DUB);
                let index = self.private_index(node);
                self.add_index(0, XS_CODE_GET_PRIVATE_1, index);
                *result = 1;
                Step::Up
            }
            Resume::MemberAtThis {
                node,
                is_super,
                flag,
                second: false,
            } => {
                // With a flag, `fxMemberAtNodeCodeReference(flag=0)`:
                // reference, at, then `AT`; otherwise the object is `DUB`'d
                // as the receiver before the key.
                if flag == 0 {
                    self.add_byte(1, XS_CODE_DUB);
                }
                stack.push(Resume::MemberAtThis {
                    node,
                    is_super,
                    flag,
                    second: true,
                });
                Step::Code(&node.children[1])
            }
            Resume::MemberAtThis { is_super, flag, .. } => {
                self.add_byte(
                    0,
                    if is_super {
                        XS_CODE_SUPER_AT
                    } else {
                        XS_CODE_AT
                    },
                );
                let mut flag = flag;
                if flag != 0 {
                    self.add_byte(2, XS_CODE_DUB_AT);
                    flag = 2;
                }
                self.add_byte(
                    -1,
                    if is_super {
                        XS_CODE_GET_SUPER_AT
                    } else {
                        XS_CODE_GET_PROPERTY_AT
                    },
                );
                *result = flag;
                Step::Up
            }
            Resume::ChainThis { target, saved } => {
                // The receiver-setup result of the chain's own reference
                // stays the walk's result.
                self.place_target(0, target);
                self.chain_target = saved;
                Step::Up
            }
            Resume::OptionThis {
                swap_target,
                skip_target,
            } => {
                // The callee left a receiver/value pair on the stack, so a
                // nullish base must drop the receiver (`SWAP`/`POP`) before
                // short-circuiting the whole chain to `undefined`; a present
                // base skips that dance and continues the call.
                let chain_target = self.chain_target.expect("optional `?.` outside a chain");
                self.add_branch(0, XS_CODE_BRANCH_CHAIN_1, swap_target);
                self.add_branch(1, XS_CODE_BRANCH_1, skip_target);
                self.place_target(0, swap_target);
                self.add_byte(0, XS_CODE_SWAP);
                self.add_byte(-1, XS_CODE_POP);
                self.add_branch(0, XS_CODE_BRANCH_1, chain_target);
                self.place_target(0, skip_target);
                Step::Up
            }
        }
    }
}

#[cfg(test)]
mod tests {
    use std::collections::BTreeSet;

    /// The tokens of the arm pattern ending in `arm_end` in [`Coder::enter`].
    fn arm_tokens(walk: &str, arm_end: &str) -> BTreeSet<String> {
        let end = walk.find(arm_end).expect("the arm");
        let start = walk[..end]
            .rfind("\n            ")
            .expect("the arm's first line");
        // A pattern rustfmt splits continues on lines starting with `|`.
        let start = walk[..start]
            .rfind([',', '}', '{'])
            .map_or(start, |at| at + 1);
        walk[start..end]
            .split('|')
            .map(|token| token.trim().to_string())
            .filter(|token| !token.is_empty())
            .collect()
    }

    /// The `Token::` variants a `fn …(token: Token) -> i32` table maps.
    fn table_tokens(coder: &str, table: &str) -> BTreeSet<String> {
        let start = coder.find(table).expect("the table");
        let body =
            &coder[start..start + coder[start..].find("_ => unreachable!").expect("its end")];
        body.lines()
            .filter_map(|line| line.trim().strip_prefix("Token::"))
            .map(|rest| rest.split(' ').next().expect("a variant").to_string())
            .collect()
    }

    /// The walk's binary and unary arms must name exactly the operators
    /// `binary_code` and `unary_code` map: a token the arm names that the
    /// table does not would reach its `unreachable!`, and one the table maps
    /// that the arm does not would never be coded as an operator.
    #[test]
    fn operator_arms_match_their_opcode_tables() {
        let walk = include_str!("walk.rs");
        let coder = include_str!("../coder.rs");
        let binary = arm_tokens(walk, "=> (Resume::BinaryRight(node)");
        let unary = arm_tokens(walk, "=> {\n                (Resume::Unary(node.token)");
        assert_eq!(
            binary,
            table_tokens(coder, "fn binary_code(token: Token) -> i32 {")
        );
        assert_eq!(
            unary,
            table_tokens(coder, "fn unary_code(token: Token) -> i32 {")
        );
        assert_eq!((binary.len(), unary.len()), (22, 6));
    }
}
