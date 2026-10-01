//! The scoper's hoist and bind passes as loops over explicit continuation
//! stacks (STACK-DEPTH-REFACTOR.md §4.6 D2).
//!
//! Each pass visits every node once through `descend` (a work charge, the
//! [`TREE_DEPTH_LIMIT`] check and a level), and most arms do some work, visit
//! their children in a fixed order, and do some more. Recursing, a call or
//! `??` chain, a tagged-template chain or a nest of functions took one group
//! of host frames per level: a 2,044-link call chain needed 461 KB of native
//! stack to scope. Here each arm is split at the points where it visits a
//! child: the part before runs when the node is entered, and the rest waits
//! on the stack as a [`Hoist`] or [`Bind`] continuation until the child is
//! done. So the arms do the same work in the same order, every charge and
//! early error included, and the walk takes a heap entry per suspended arm
//! instead of host frames.
//!
//! The arms that stay functions are the program and module roots, classes
//! (whose nesting the parser's budget bounds: 52 levels through `extends`, 90
//! through field initializers), and the leaves, which visit no child. A child
//! they visit through `hoist_item` or `bind_item` starts a new walk. As with
//! D1's explicit-stack default arms, an error ends the walk without releasing
//! the levels it entered (`descend` still releases the walk's root):
//! `run_goal_with_access_log` returns the error and drops the `Scoper`
//! without reading `depth` again.

use super::*;

/// A hoist arm suspended while one of its children is hoisted.
enum Hoist<'n> {
    /// `descend`'s exit for a node entered in place: release its level.
    Leave,
    /// `fxNodeHoist` over a run of items, in order (`hoist_item` on each).
    Items(&'n [Item], usize),
    /// Close a block or `with` scope the arm opened (`fxScopeHoisted`).
    Hoisted(usize),
    /// `fxBodyNodeHoist`: restore the environment node, close the scope.
    Body { si: usize, env: Option<u32> },
    /// `fxFunctionNodeHoist`, after the parameters.
    FunctionParams(FunctionHoist<'n>),
    /// `fxFunctionNodeHoist`, after the body.
    FunctionBody(FunctionHoist<'n>, bool),
    /// `fxCatchNodeHoist` with a parameter, after it.
    CatchParam { node: &'n Node, scope: usize },
    /// `fxCatchNodeHoist`, after the statement: `scope` is the parameter
    /// scope, or `None` without a parameter.
    CatchStatement {
        node: &'n Node,
        scope: Option<usize>,
        statement_scope: usize,
    },
    /// `fxSwitchNodeHoist`, after the expression.
    SwitchExpression(&'n Node),
    /// `fxWithNodeHoist`, after the expression.
    WithExpression(&'n Node),
}

/// What `fxFunctionNodeHoist` keeps across its children.
struct FunctionHoist<'n> {
    node: &'n Node,
    si: usize,
    function_scope: Option<usize>,
    body_scope: Option<usize>,
}

/// A bind arm suspended while one of its children is bound.
enum Bind<'n> {
    /// `descend`'s exit for a node entered in place: release its level.
    Leave,
    /// `fxNodeBind` over a run of items, in order (`bind_item` on each).
    Items(&'n [Item], usize),
    /// Release frame variables the arm reserved (`fxBinderPopVariables`).
    Pop(i32),
    /// Close a scope the arm entered, first releasing the two disposal
    /// variables if it reserved them (`fxScopeBound`).
    Bound { si: usize, disposal: bool },
    /// `fxFunctionNodeBind`, after the parameters.
    FunctionParams(FunctionBind<'n>),
    /// `fxFunctionNodeBind`, after the body.
    FunctionBody(FunctionBind<'n>),
    /// `fxCatchNodeBind` with a parameter, after it.
    CatchParam {
        node: &'n Node,
        scope: usize,
        statement_scope: usize,
    },
    /// `fxCatchNodeBind`, after the statement: close the statement scope
    /// (`scope` is the parameter scope, or `None` without a parameter).
    CatchStatement {
        scope: Option<usize>,
        statement_scope: usize,
        disposal: bool,
    },
    /// `fxSwitchNodeBind`, after the expression.
    SwitchExpression(&'n Node),
    /// `fxWithNodeBind`, after the expression.
    WithExpression(&'n Node),
    /// `fxSuperNodeBind`, after the arguments.
    Super(&'n Node),
    /// `fxPostfixExpressionNodeBind`, after the operand.
    Postfix,
}

/// What `fxFunctionNodeBind` keeps across its children.
struct FunctionBind<'n> {
    node: &'n Node,
    si: usize,
    level: i32,
    maximum: i32,
}

/// The first `n` children of `node` (fewer if it has fewer), which the arms
/// visit in order through `child(node, i)`.
fn first_children(node: &Node, n: usize) -> &[Item] {
    &node.children[..node.children.len().min(n)]
}

/// Child `i` of `node` as a run of at most one item.
fn child_items(node: &Node, i: usize) -> &[Item] {
    node.children
        .get(i)
        .map(std::slice::from_ref)
        .unwrap_or(&[])
}

impl Scoper<'_> {
    /// `fxNodeDispatchHoist` for a node `descend` has entered: run its arm
    /// and every arm under it that the walk runs.
    pub(super) fn hoist_walk(&mut self, root: &Node) -> Result<(), ParseError> {
        let mut stack: Vec<Hoist<'_>> = Vec::new();
        self.hoist_enter(root, &mut stack)?;
        while let Some(top) = stack.pop() {
            match top {
                Hoist::Leave => self.depth -= 1,
                Hoist::Items(items, i) => {
                    let Some(item) = items.get(i) else { continue };
                    stack.push(Hoist::Items(items, i + 1));
                    match item {
                        Item::List(v) => stack.push(Hoist::Items(v, 0)),
                        Item::Node(n) => {
                            // `descend`'s entry, in place.
                            self.meter.work(1);
                            if self.depth >= TREE_DEPTH_LIMIT {
                                return Err(err(n.line, "stack overflow"));
                            }
                            self.depth += 1;
                            stack.push(Hoist::Leave);
                            self.hoist_enter(n, &mut stack)?;
                        }
                        _ => {}
                    }
                }
                other => self.hoist_resume(other, &mut stack)?,
            }
        }
        Ok(())
    }

    /// Start `node`'s hoist arm: run it whole if it is one that stays a
    /// function, or do what it does before its first child and push the
    /// rest.
    #[inline(never)]
    fn hoist_enter<'n>(
        &mut self,
        node: &'n Node,
        stack: &mut Vec<Hoist<'n>>,
    ) -> Result<(), ParseError> {
        match node.token {
            Token::Program => self.hoist_program(node),
            Token::Module => self.hoist_module(node),
            Token::Arg | Token::Var | Token::Let | Token::Const | Token::Using => {
                self.hoist_declare(node)
            }
            Token::String => self.hoist_string(node),
            Token::Import => self.hoist_import(node),
            Token::Export => self.hoist_export(node),
            Token::Class => self.hoist_class(node),
            Token::Block => {
                let si = self.scope_new(node, Token::Block);
                self.node_scope.insert(node_id(node), (si, None));
                stack.push(Hoist::Hoisted(si));
                stack.push(Hoist::Items(child_items(node, 0), 0));
                Ok(())
            }
            Token::Body => {
                let si = self.scope_new(node, Token::Block);
                self.body_scope = Some(si);
                self.node_scope.insert(node_id(node), (si, None));
                let env = self.environment_node;
                self.environment_node = Some(node_id(node));
                stack.push(Hoist::Body { si, env });
                stack.push(Hoist::Items(child_items(node, 0), 0));
                Ok(())
            }
            Token::Function | Token::Generator => {
                self.hoist_function_enter(node, true, stack);
                Ok(())
            }
            Token::Call | Token::New => {
                // children[0] = reference, children[1] = params
                if let Some(reference) = child_node(node, 0) {
                    if reference.token == Token::Access {
                        if let Some(sym) = child_sym(reference, 0) {
                            if sym == "eval" {
                                self.scope_eval(self.scope);
                                if let Some(fs) = self.function_scope {
                                    let fptr = self.scopes[fs].node_id;
                                    self.add_extra(fptr, flags::ARGUMENTS | SCOPE_EVAL);
                                }
                                if let Some(env) = self.environment_node {
                                    self.add_extra(env, SCOPE_EVAL);
                                }
                                // params->flags |= mxEvalParametersFlag — coder use.
                            }
                        }
                    }
                }
                stack.push(Hoist::Items(first_children(node, 2), 0));
                Ok(())
            }
            Token::Catch => {
                // children[0] = parameter (or Null), children[1] = statement
                if matches!(child(node, 0), Some(Item::Node(_))) {
                    let simple = matches!(
                        child(node, 0),
                        Some(Item::Node(param)) if param.token == Token::Let
                    );
                    let scope = self.scope_new(node, Token::Block);
                    self.scopes[scope].simple_catch_parameter = simple;
                    stack.push(Hoist::CatchParam { node, scope });
                    stack.push(Hoist::Items(child_items(node, 0), 0));
                } else {
                    let statement_scope = self.scope_new(node, Token::Block);
                    stack.push(Hoist::CatchStatement {
                        node,
                        scope: None,
                        statement_scope,
                    });
                    stack.push(Hoist::Items(child_items(node, 1), 0));
                }
                Ok(())
            }
            Token::Coalesce => {
                // early error: mixing ?? with && / || without parentheses
                if let Some(l) = child_node(node, 0) {
                    if l.token == Token::And {
                        return Err(err(node.line, "missing () around &&"));
                    }
                    if l.token == Token::Or {
                        return Err(err(node.line, "missing () around ||"));
                    }
                }
                if let Some(r) = child_node(node, 1) {
                    if r.token == Token::And {
                        return Err(err(node.line, "missing () around &&"));
                    }
                    if r.token == Token::Or {
                        return Err(err(node.line, "missing () around ||"));
                    }
                }
                stack.push(Hoist::Items(&node.children, 0));
                Ok(())
            }
            Token::Define => {
                if !self.hoist_define(node)? {
                    return Ok(());
                }
                // Dispatch the initializer (a function) with its self-symbol
                // nulled (`fxDefineNodeHoist` nulls `initializer->symbol`), so
                // a declaration creates no named-expression self-binding. A
                // function initializer is hoisted directly, not through
                // `descend`.
                if let Some(init) = child_node(node, 1) {
                    if init.token == Token::Function || init.token == Token::Generator {
                        self.hoist_function_enter(init, false, stack);
                    } else {
                        stack.push(Hoist::Items(child_items(node, 1), 0));
                    }
                }
                Ok(())
            }
            Token::For | Token::ForIn | Token::ForOf | Token::ForAwaitOf => {
                let si = self.scope_new(node, Token::Block);
                self.node_scope.insert(node_id(node), (si, None));
                let count = if node.token == Token::For { 4 } else { 3 };
                stack.push(Hoist::Hoisted(si));
                stack.push(Hoist::Items(first_children(node, count), 0));
                Ok(())
            }
            Token::Switch => {
                // children[0] = expression, children[1] = items (list of Case)
                stack.push(Hoist::SwitchExpression(node));
                stack.push(Hoist::Items(child_items(node, 0), 0));
                Ok(())
            }
            Token::With => {
                // children[0] = expression, children[1] = statement
                stack.push(Hoist::WithExpression(node));
                stack.push(Hoist::Items(child_items(node, 0), 0));
                Ok(())
            }
            // fold: Host — deferred (see report).
            _ => {
                stack.push(Hoist::Items(&node.children, 0));
                Ok(())
            }
        }
    }

    /// `fxFunctionNodeHoist` up to its parameters: open the function scope,
    /// with a named function expression's `CONST` self-binding when `named`.
    fn hoist_function_enter<'n>(
        &mut self,
        node: &'n Node,
        named: bool,
        stack: &mut Vec<Hoist<'n>>,
    ) {
        let function_scope = self.function_scope;
        let body_scope = self.body_scope;
        let si = self.scope_new(node, Token::Function);
        self.function_scope = Some(si);
        self.body_scope = None;
        self.node_scope.insert(node_id(node), (si, None));
        // named function expression: a CONST self-binding define.
        if named {
            if let Some(sym) = child_sym(node, 0) {
                let s = Sym::Named(sym);
                let d = self.new_declare(si, Token::Define, Some(s.clone()), node.line);
                self.scope_add_declare(si, d);
                self.scope_add_define(si, Some(s), node.line);
            }
        }
        stack.push(Hoist::FunctionParams(FunctionHoist {
            node,
            si,
            function_scope,
            body_scope,
        }));
        // params (children[1])
        stack.push(Hoist::Items(child_items(node, 1), 0));
    }

    /// Continue a suspended hoist arm now that the child it waited on is
    /// done.
    #[inline(never)]
    fn hoist_resume<'n>(
        &mut self,
        resume: Hoist<'n>,
        stack: &mut Vec<Hoist<'n>>,
    ) -> Result<(), ParseError> {
        match resume {
            Hoist::Leave | Hoist::Items(..) => unreachable!("handled by the walk"),
            Hoist::Hoisted(si) => self.fx_scope_hoisted(si),
            Hoist::Body { si, env } => {
                self.environment_node = env;
                self.fx_scope_hoisted(si);
            }
            Hoist::FunctionParams(function) => {
                // `arguments` injection (`fxFunctionNodeHoist`, before the
                // body). A function that references or declares `arguments`,
                // or that the parser already marked as containing `eval`,
                // has the flag *now*: inject here, before the body's own
                // `var arguments`/`arguments` parameter is hoisted, so the two
                // merge into one declare (XS relies on the synthetic being
                // present first).
                let injected = self.inject_arguments(function.si, function.node);
                let body = child_items(function.node, 2);
                stack.push(Hoist::FunctionBody(function, injected));
                // body (children[2])
                stack.push(Hoist::Items(body, 0));
            }
            Hoist::FunctionBody(function, injected) => {
                // A *body-level direct `eval`* only marks the function node
                // once its call is hoisted (the `Call` arm's `add_extra`), too
                // late for the injection above. Inject now if that discovery
                // set the flag and nothing was injected yet. Such a function
                // has no `var arguments`/`arguments` parameter (those would
                // have set the flag at parse), so this never double-injects;
                // the body's declares live in the separate body scope, so the
                // `arguments` `Var` still follows the parameters.
                if !injected {
                    self.inject_arguments(function.si, function.node);
                }
                self.fx_scope_hoisted(function.si);
                self.body_scope = function.body_scope;
                self.function_scope = function.function_scope;
            }
            Hoist::CatchParam { node, scope } => {
                let statement_scope = self.scope_new(node, Token::Block);
                stack.push(Hoist::CatchStatement {
                    node,
                    scope: Some(scope),
                    statement_scope,
                });
                stack.push(Hoist::Items(child_items(node, 1), 0));
            }
            Hoist::CatchStatement {
                node,
                scope: Some(scope),
                statement_scope,
            } => {
                self.fx_scope_hoisted(statement_scope);
                self.fx_scope_hoisted(scope);
                self.node_scope
                    .insert(node_id(node), (scope, Some(statement_scope)));
                // duplicate: a statementScope declare that also names a
                // parameter is a redeclaration error.
                let names: Vec<(Option<Sym>, u32)> = self.scopes[statement_scope]
                    .declares
                    .iter()
                    .map(|d| (d.symbol.clone(), d.line))
                    .collect();
                for (sym, line) in names {
                    if let Some(s) = &sym {
                        if self.scope_get_declare(scope, s).is_some() {
                            return Err(err(line, "duplicate variable"));
                        }
                    }
                }
            }
            Hoist::CatchStatement {
                node,
                scope: None,
                statement_scope,
            } => {
                self.fx_scope_hoisted(statement_scope);
                self.node_scope
                    .insert(node_id(node), (statement_scope, None));
            }
            Hoist::SwitchExpression(node) => {
                let si = self.scope_new(node, Token::Block);
                self.node_scope.insert(node_id(node), (si, None));
                stack.push(Hoist::Hoisted(si));
                stack.push(Hoist::Items(child_items(node, 1), 0));
            }
            Hoist::WithExpression(node) => {
                let si = self.scope_new(node, Token::With);
                self.node_scope.insert(node_id(node), (si, None));
                self.scope_eval(self.scopes[si].parent);
                stack.push(Hoist::Hoisted(si));
                stack.push(Hoist::Items(child_items(node, 1), 0));
            }
        }
        Ok(())
    }

    /// `fxNodeDispatchBind` for a node `descend` has entered: run its arm
    /// and every arm under it that the walk runs.
    pub(super) fn bind_walk(&mut self, root: &Node) -> Result<(), ParseError> {
        let mut stack: Vec<Bind<'_>> = Vec::new();
        self.bind_enter(root, &mut stack)?;
        while let Some(top) = stack.pop() {
            match top {
                Bind::Leave => self.depth -= 1,
                Bind::Items(items, i) => {
                    let Some(item) = items.get(i) else { continue };
                    stack.push(Bind::Items(items, i + 1));
                    match item {
                        Item::List(v) => stack.push(Bind::Items(v, 0)),
                        Item::Node(n) => {
                            // `descend`'s entry, in place.
                            self.meter.work(1);
                            if self.depth >= TREE_DEPTH_LIMIT {
                                return Err(err(n.line, "stack overflow"));
                            }
                            self.depth += 1;
                            stack.push(Bind::Leave);
                            self.bind_enter(n, &mut stack)?;
                        }
                        _ => {}
                    }
                }
                Bind::Pop(count) => self.pop_variables(count),
                other => self.bind_resume(other, &mut stack)?,
            }
        }
        Ok(())
    }

    /// Start `node`'s bind arm: run it whole if it is one that stays a
    /// function, or do what it does before its first child and push the
    /// rest.
    #[inline(never)]
    fn bind_enter<'n>(
        &mut self,
        node: &'n Node,
        stack: &mut Vec<Bind<'n>>,
    ) -> Result<(), ParseError> {
        match node.token {
            Token::Program => self.bind_program(node),
            Token::Module => self.bind_module(node),
            Token::Access => self.bind_access(node),
            Token::Arg | Token::Var | Token::Let | Token::Const | Token::Using => {
                self.bind_declare_node(node)
            }
            Token::This | Token::Target => {
                self.scope_arrow(self.scope);
                Ok(())
            }
            Token::Export => self.bind_export(node),
            Token::Class => self.bind_class(node),
            Token::Block | Token::Body => {
                let (si, _) = self.scope_of(node);
                self.fx_scope_binding(si);
                let disposal = self.scopes[si].disposable_count > 0;
                if disposal {
                    self.push_variables(2);
                }
                stack.push(Bind::Bound { si, disposal });
                stack.push(Bind::Items(child_items(node, 0), 0));
                Ok(())
            }
            Token::Function | Token::Generator => {
                let (si, _) = self.scope_of(node);
                let level = self.scope_level;
                let maximum = self.scope_maximum;
                self.scope_level = 0;
                self.scope_maximum = 0;
                self.fx_scope_binding(si);
                stack.push(Bind::FunctionParams(FunctionBind {
                    node,
                    si,
                    level,
                    maximum,
                }));
                stack.push(Bind::Items(child_items(node, 1), 0));
                Ok(())
            }
            Token::Define => {
                if let Some(sym) = child_sym(node, 0) {
                    let scope = self.scope.unwrap();
                    let resolved = self.scope_lookup(scope, &Sym::Named(sym.clone()), None, false);
                    if let Some((rscope, rid)) = resolved {
                        self.declare_mut(rscope, rid).bound = true;
                    }
                    self.record_access(&sym, node.line, resolved);
                    self.resolutions.insert(node_id(node), resolved);
                }
                stack.push(Bind::Items(child_items(node, 1), 0));
                Ok(())
            }
            // children[0]=reference, children[1]=value; children[0]=target,
            // children[1]=initializer
            Token::Assign | Token::Binding => {
                stack.push(Bind::Items(first_children(node, 2), 0));
                Ok(())
            }
            Token::Catch => {
                let (scope, statement_scope) = self.scope_of(node);
                if matches!(child(node, 0), Some(Item::Node(_))) {
                    let statement_scope = statement_scope.unwrap();
                    self.fx_scope_binding(scope);
                    stack.push(Bind::CatchParam {
                        node,
                        scope,
                        statement_scope,
                    });
                    stack.push(Bind::Items(child_items(node, 0), 0));
                } else {
                    // `scope` holds the statementScope when there is no
                    // parameter.
                    self.fx_scope_binding(scope);
                    let disposal = self.scopes[scope].disposable_count > 0;
                    if disposal {
                        self.push_variables(2);
                    }
                    stack.push(Bind::CatchStatement {
                        scope: None,
                        statement_scope: scope,
                        disposal,
                    });
                    stack.push(Bind::Items(child_items(node, 1), 0));
                }
                Ok(())
            }
            Token::For => {
                let (si, _) = self.scope_of(node);
                self.fx_scope_binding(si);
                let disposal = self.scopes[si].disposable_count > 0;
                if disposal {
                    self.push_variables(2);
                }
                stack.push(Bind::Bound { si, disposal });
                stack.push(Bind::Items(first_children(node, 4), 0));
                Ok(())
            }
            Token::ForIn | Token::ForOf | Token::ForAwaitOf => {
                let (si, _) = self.scope_of(node);
                self.push_variables(6);
                self.fx_scope_binding(si);
                stack.push(Bind::Pop(6));
                stack.push(Bind::Bound {
                    si,
                    disposal: false,
                });
                stack.push(Bind::Items(first_children(node, 3), 0));
                Ok(())
            }
            Token::Switch => {
                stack.push(Bind::SwitchExpression(node));
                stack.push(Bind::Items(child_items(node, 0), 0));
                Ok(())
            }
            Token::With => {
                stack.push(Bind::WithExpression(node));
                stack.push(Bind::Items(child_items(node, 0), 0));
                Ok(())
            }
            Token::Try => {
                self.push_variables(3);
                stack.push(Bind::Pop(3));
                stack.push(Bind::Items(first_children(node, 3), 0));
                Ok(())
            }
            Token::Array => {
                self.push_variables(1);
                stack.push(Bind::Pop(1));
                if node.flags & flags::SPREAD != 0 {
                    self.push_variables(2);
                    stack.push(Bind::Pop(2));
                }
                stack.push(Bind::Items(&node.children, 0));
                Ok(())
            }
            Token::ArrayBinding => {
                self.push_variables(6);
                stack.push(Bind::Pop(6));
                stack.push(Bind::Items(&node.children, 0));
                Ok(())
            }
            Token::Object => {
                self.push_variables(1);
                self.bind_object_accessor_flags(node);
                stack.push(Bind::Pop(1));
                stack.push(Bind::Items(&node.children, 0));
                Ok(())
            }
            Token::ObjectBinding => {
                self.push_variables(2);
                stack.push(Bind::Pop(2));
                stack.push(Bind::Items(&node.children, 0));
                Ok(())
            }
            Token::Params => {
                if node.flags & flags::SPREAD != 0 {
                    self.push_variables(1);
                    stack.push(Bind::Pop(1));
                }
                stack.push(Bind::Items(&node.children, 0));
                Ok(())
            }
            Token::ParamsBinding => {
                self.bind_params_binding(node)?;
                stack.push(Bind::Items(&node.children, 0));
                Ok(())
            }
            Token::Spread => {
                self.push_variables(1);
                stack.push(Bind::Pop(1));
                stack.push(Bind::Items(&node.children, 0));
                Ok(())
            }
            Token::Delegate => {
                self.push_variables(5);
                stack.push(Bind::Pop(5));
                stack.push(Bind::Items(child_items(node, 0), 0));
                Ok(())
            }
            Token::Template => {
                // children[0]=reference (Null for untagged), children[1]=items
                if matches!(child(node, 0), Some(Item::Node(_))) {
                    self.push_variables(2);
                    stack.push(Bind::Pop(2));
                }
                stack.push(Bind::Items(&node.children, 0));
                Ok(())
            }
            Token::Super => {
                self.scope_arrow(self.scope);
                stack.push(Bind::Super(node));
                stack.push(Bind::Items(child_items(node, 0), 0));
                Ok(())
            }
            Token::Increment | Token::Decrement => {
                stack.push(Bind::Postfix);
                stack.push(Bind::Items(child_items(node, 0), 0));
                Ok(())
            }
            Token::PrivateMember | Token::PrivateIdentifier => {
                self.bind_private_member(node)?;
                // The reference (child 1) binds after the lookup, matching
                // `fxPrivateMemberNodeDistribute`.
                stack.push(Bind::Items(child_items(node, 1), 0));
                Ok(())
            }
            Token::Delete => {
                if let Some(target) = node.children.first() {
                    if delete_target_is_private(target) {
                        return Err(err(node.line, "delete private property"));
                    }
                }
                stack.push(Bind::Items(&node.children, 0));
                Ok(())
            }
            // fold: Field — deferred.
            _ => {
                stack.push(Bind::Items(&node.children, 0));
                Ok(())
            }
        }
    }

    /// Continue a suspended bind arm now that the child it waited on is done.
    #[inline(never)]
    fn bind_resume<'n>(
        &mut self,
        resume: Bind<'n>,
        stack: &mut Vec<Bind<'n>>,
    ) -> Result<(), ParseError> {
        match resume {
            Bind::Leave | Bind::Items(..) | Bind::Pop(_) => unreachable!("handled by the walk"),
            Bind::Bound { si, disposal } => {
                if disposal {
                    self.pop_variables(2);
                }
                self.fx_scope_bound(si);
            }
            Bind::FunctionParams(function) => {
                self.bind_base_constructor(function.node, function.si);
                let body = child_items(function.node, 2);
                stack.push(Bind::FunctionBody(function));
                stack.push(Bind::Items(body, 0));
            }
            Bind::FunctionBody(function) => {
                self.fx_scope_bound(function.si);
                self.scope_counts.insert(function.si, self.scope_maximum);
                self.scope_maximum = function.maximum;
                self.scope_level = function.level;
            }
            Bind::CatchParam {
                node,
                scope,
                statement_scope,
            } => {
                self.fx_scope_binding(statement_scope);
                let disposal = self.scopes[statement_scope].disposable_count > 0;
                if disposal {
                    self.push_variables(2);
                }
                stack.push(Bind::CatchStatement {
                    scope: Some(scope),
                    statement_scope,
                    disposal,
                });
                stack.push(Bind::Items(child_items(node, 1), 0));
            }
            Bind::CatchStatement {
                scope,
                statement_scope,
                disposal,
            } => {
                if disposal {
                    // NOTE: XS's fxCatchNodeBind pushes (not pops) here too;
                    // transliterated faithfully.
                    self.push_variables(2);
                }
                self.fx_scope_bound(statement_scope);
                if let Some(scope) = scope {
                    self.fx_scope_bound(scope);
                }
            }
            Bind::SwitchExpression(node) => {
                let (si, _) = self.scope_of(node);
                self.fx_scope_binding(si);
                let disposal = self.scopes[si].disposable_count > 0;
                if disposal {
                    self.push_variables(2);
                }
                stack.push(Bind::Bound { si, disposal });
                stack.push(Bind::Items(child_items(node, 1), 0));
            }
            Bind::WithExpression(node) => {
                let (si, _) = self.scope_of(node);
                self.fx_scope_binding(si);
                stack.push(Bind::Bound {
                    si,
                    disposal: false,
                });
                stack.push(Bind::Items(child_items(node, 1), 0));
            }
            Bind::Super(node) => self.bind_super_instance_init(node),
            Bind::Postfix => {
                self.push_variables(1);
                self.pop_variables(1);
            }
        }
        Ok(())
    }
}
