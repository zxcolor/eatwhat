// One process-local canteen round. No wx storage, account context or async work.
let cached = null;
let nextLease = 0;
let ownerLease = null;

function owns(lease) { return cached !== null && lease !== null && lease === ownerLease; }

function current(lease, round, profileKey, epoch) {
  return owns(lease) && cached.round === round && cached.profileKey === profileKey && cached.epoch === epoch;
}

function claim(profileKey, epoch, createRound) {
  const hiddenFilters = cached?.stallId && Object.values(cached.dishFilters).some(value => value !== null);
  if (!cached || cached.profileKey !== profileKey || cached.epoch !== epoch || hiddenFilters) {
    const selection = cached && cached.epoch === epoch
      ? { stallId: cached.stallId, dishFilters: cached.stallId
        ? { stapleType: null, hasSoup: null, temperature: null } : { ...cached.dishFilters } }
      : { stallId: null, dishFilters: { stapleType: null, hasSoup: null, temperature: null } };
    cached = {
      round: createRound(selection), profileKey, epoch, stallId: selection.stallId,
      dishFilters: { ...selection.dishFilters },
      decisionSource: '', decisionNote: '',
    };
  }
  ownerLease = ++nextLease;
  return { lease: ownerLease, round: cached.round, profileKey: cached.profileKey,
    epoch: cached.epoch, stallId: cached.stallId, dishFilters: { ...cached.dishFilters },
    decisionSource: cached.decisionSource, decisionNote: cached.decisionNote };
}

function replace(lease, previousRound, round, stallId, dishFilters) {
  if (!owns(lease) || cached.round !== previousRound) return false;
  if (stallId && Object.values(dishFilters).some(value => value !== null)) return false;
  cached.round = round;
  cached.stallId = stallId;
  cached.dishFilters = { stapleType: dishFilters.stapleType, hasSoup: dishFilters.hasSoup, temperature: dishFilters.temperature };
  cached.decisionSource = '';
  cached.decisionNote = '';
  return true;
}

function setSource(lease, round, source, note) {
  if (!owns(lease) || cached.round !== round) return false;
  // Only app-authored public presentation strings accompany the chosen dish.
  cached.decisionSource = typeof source === 'string' ? source : '';
  cached.decisionNote = typeof note === 'string' ? note : '';
  return true;
}

function release(lease) {
  if (owns(lease)) ownerLease = null;
}

function clear() {
  cached = null;
  ownerLease = null;
}

module.exports = { claim, owns, current, replace, setSource, release, clear };
