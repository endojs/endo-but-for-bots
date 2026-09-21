'use strict';
(function () {
function makeFacet(shared, facetIndex, methodCount) {
    if (methodCount === 2) {
      return { step: function (delta) { shared.value += delta + facetIndex; return shared.value; }, read: function () { return shared.value; } };
    }
    return { step: function (delta) { shared.value += delta + facetIndex; return shared.value; }, read: function () { return shared.value; }, tagged: function () { return shared.value + facetIndex; }, index: function () { return facetIndex; } };
  }
  function makeCohort(seed, facetCount, methodCount) {
    var shared = { value: seed };
    var facets = [];
    for (var facetIndex = 0; facetIndex < facetCount; facetIndex += 1) facets.push(makeFacet(shared, facetIndex, methodCount));
    return facets;
  }
  var checksum = 0;
  var cohortCount = 0;
  var facetCounts = [2, 4, 8];
  var methodCounts = [2, 4];
  for (var facetShape = 0; facetShape < facetCounts.length; facetShape += 1) {
    for (var methodShape = 0; methodShape < methodCounts.length; methodShape += 1) {
      for (var cohortIndex = 0; cohortIndex < 256; cohortIndex += 1) {
        var facets = makeCohort(cohortIndex, facetCounts[facetShape], methodCounts[methodShape]);
        cohortCount += 1;
        for (var facetIndex = 0; facetIndex < facets.length; facetIndex += 1) {
          checksum += facets[facetIndex].step(1);
          if (methodCounts[methodShape] === 4) checksum += facets[facetIndex].tagged() + facets[facetIndex].index();
        }
      }
    }
  }
  return 'facet-cohort:256:' + checksum + ':' + cohortCount;
}())
