use super::*;

#[test]
fn nested_finalizers_restore_original_target_chains_and_propagate_use() {
    for used in 0..8 {
        let tree = crate::scoper::scope_program("0", false).unwrap();
        let mut coder = Coder::new(&tree, crate::ParseMeter::new());
        let originals: Vec<_> = (0..3).map(|_| coder.create_target()).collect();
        for pair in originals.windows(2) {
            coder.targets[pair[0]].next_target = Some(pair[1]);
        }
        coder.targets[originals[0]].labels = vec![Some("outer".into())];
        let first = coder.alias_targets(Some(originals[0]));
        let second = coder.alias_targets(first);
        let mut outer = first;
        let mut inner = second;
        for (index, original) in originals.iter().enumerate() {
            let a = outer.unwrap();
            let b = inner.unwrap();
            assert_eq!(coder.targets[a].original, Some(*original));
            assert_eq!(coder.targets[b].original, Some(a));
            assert_eq!(coder.targets[a].labels, coder.targets[*original].labels);
            assert_eq!(coder.targets[b].labels, coder.targets[a].labels);
            coder.targets[b].used = used & (1 << index) != 0;
            outer = coder.targets[a].next_target;
            inner = coder.targets[b].next_target;
        }
        assert_eq!(outer, None);
        assert_eq!(inner, None);
        let finally = coder.create_target();
        let mut selection = 1;
        assert_eq!(
            coder.finalize_targets(second, 0, &mut selection, finally),
            first
        );
        assert_eq!(selection, 4);
        selection = 1;
        assert_eq!(
            coder.finalize_targets(first, 0, &mut selection, finally),
            Some(originals[0])
        );
        assert_eq!(selection, 4);
        for (index, original) in originals.iter().enumerate() {
            assert_eq!(coder.targets[*original].used, used & (1 << index) != 0);
        }
        assert_eq!(coder.alias_targets(None), None);
        assert_eq!(
            coder.finalize_targets(None, 0, &mut selection, finally),
            None
        );
        assert_eq!(selection, 4, "an absent chain consumes no selector values");
    }
}
