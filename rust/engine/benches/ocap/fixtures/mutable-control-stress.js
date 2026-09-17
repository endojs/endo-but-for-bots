'use strict';
(function () {
function makePromiseKit() {
    var resolve;
    var reject;
    var promise = new Promise(function (resolvePromise, rejectPromise) { resolve = resolvePromise; reject = rejectPromise; });
    var kit = { promise: promise, resolve: resolve, reject: reject };
    return kit;
  }
  var facetStates = new WeakMap();
  function facetStep(delta) { var state = facetStates.get(this); state.shared.value += delta + state.facetIndex; return state.shared.value; }
  function facetRead() { return facetStates.get(this).shared.value; }
  function facetTagged() { var state = facetStates.get(this); return state.shared.value + state.facetIndex; }
  function facetIndexMethod() { return facetStates.get(this).facetIndex; }
  function makeFacet(shared, facetIndex) {
    var facet = {
      step: facetStep,
      read: facetRead,
      tagged: facetTagged,
      index: facetIndexMethod
    };
    facetStates.set(facet, { shared: shared, facetIndex: facetIndex });
    return facet;
  }
  function makeForwarder(target) {
    var active = true;
    var forwarder = { call: function (delta) { return active ? target.step(delta) : -1; } };
    var control = { revoke: function () { active = false; } };
    var pair = { forwarder: forwarder, control: control };
    return pair;
  }
  function makeCohort(seed) {
    var shared = { value: seed };
    var facets = [];
    for (var facetIndex = 0; facetIndex < 4; facetIndex += 1) facets.push(makeFacet(shared, facetIndex));
    var cohort = { facets: facets, promiseKit: makePromiseKit(), forwarding: makeForwarder(facets[0]) };
    return cohort;
  }
  var retained = [];
  var checksum = 0;
  for (var start = 0; start < 256; start += 16) {
    var batch = [];
    var limit = Math.min(start + 16, 256);
    for (var cohortIndex = start; cohortIndex < limit; cohortIndex += 1) {
      var cohort = makeCohort(cohortIndex);
      for (var facetIndex = 0; facetIndex < cohort.facets.length; facetIndex += 1) {
        checksum += cohort.facets[facetIndex].step(1);
        checksum += cohort.facets[facetIndex].tagged();
      }
      checksum += cohort.forwarding.forwarder.call(2);
      cohort.facets[0].step(5); cohort.extra = 11; checksum += cohort.facets[0].read() + cohort.extra;
      if (cohortIndex % 2 === 0) { cohort.forwarding.control.revoke(); checksum += cohort.forwarding.forwarder.call(1); }
      if (cohortIndex % 3 === 0) retained.push(cohort);
      batch.push(cohort);
    }
    batch = null;
  }
  return 'mutable-control:256:' + checksum + ':' + retained.length;
}())
