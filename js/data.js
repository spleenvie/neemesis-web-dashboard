function emptyData() {
  return {
    month: new Date().getMonth(),
    nid: 1,
    talentFilter: '',
    missionTab: 'all',
    openTalentId: null,
    tasks: { week: [], admin: [], brand: [], biz: [], ops: [] },
    talents: [],
    missions: [],
    revenues: [],
    notes: [],
    rev: {
      r: [0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0],
      o: [0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0]
    }
  };
}
window.emptyData = emptyData;
