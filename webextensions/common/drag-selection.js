/*
# This Source Code Form is subject to the terms of the Mozilla Public
# License, v. 2.0. If a copy of the MPL was not distributed with this
# file, You can obtain one at http://mozilla.org/MPL/2.0/.
*/
'use strict';

import {
  configs
} from './common.js';
import * as Selections from './selections.js';
import EventListenerManager from '../extlib/EventListenerManager.js';
import TabIdFixer from '../extlib/TabIdFixer.js';

export const onDragSelectionEnd = new EventListenerManager();

export const mDragSelection = {
  willCloseSelectedTabs: false,
  allTabsOnDragReady:    [],
  pendingTabs:           null,
  dragStartTarget:       null,
  lastHoverTarget:       null,
  firstHoverTarget:      null,
  undeterminedRange:     {},
  dragEnteredCount:      0,
  clear() {
    this.dragStartTarget = this.firstHoverTarget = this.lastHoverTarget = null;
    this.undeterminedRange = {};
    this.willCloseSelectedTabs = false;
    this.dragEnteredCount = 0;
    this.allTabsOnDragReady = [];
  },
  export() {
    const exported = {};
    for (const key of Object.keys(this)) {
      if (typeof this[key] != 'function')
        exported[key] = this[key];
    }
    return exported;
  },
  apply(foreignSession) {
    for (const key of Object.keys(foreignSession)) {
      if (typeof this[key] != 'function')
        this[key] = foreignSession[key];
    }
  }
};

export function serialize() {
  return mDragSelection.export();
}

export function apply(dragSelection) {
  return mDragSelection.apply(dragSelection);
}

export function getDragStartTargetId() {
  return mDragSelection.dragStartTarget && mDragSelection.dragStartTarget.id;
}

export function activateInVerticalTabbarOfTST() {
  mDragSelection.activatedInVerticalTabbarOfTST = true;
}

export function deactivateInVerticalTabbarOfTST() {
  mDragSelection.activatedInVerticalTabbarOfTST = false;
}

export function isActivatedInVerticalTabbarOfTST() {
  return !!mDragSelection.activatedInVerticalTabbarOfTST;
}

/* utilities */

function retrieveTargetTabs(serializedTab) {
  let tabs = [serializedTab];
  if (serializedTab.children &&
      serializedTab.states.indexOf('subtree-collapsed') > -1) {
    for (const tab of serializedTab.children) {
      tabs = tabs.concat(retrieveTargetTabs(tab))
    }
  }
  return tabs;
}

function getTabsBetween(aBegin, end, allTabs = []) {
  if (aBegin.id == end.id)
    return [];
  let inRange = false;
  return allTabs.filter(tab => {
    if (tab.id == aBegin.id || tab.id == end.id) {
      inRange = !inRange;
      return false;
    }
    return inRange;
  });
}

function toggleStateOfDragOverTabs(params = {}) {
  if (mDragSelection.firstHoverTarget) {
    const oldUndeterminedRange = mDragSelection.undeterminedRange;
    mDragSelection.undeterminedRange = {};

    let newUndeterminedRange = params.allTargets;
    if (newUndeterminedRange.every(tab => tab.id != mDragSelection.firstHoverTarget.id))
      newUndeterminedRange.push(mDragSelection.firstHoverTarget);

    const betweenTabs = getTabsBetween(mDragSelection.firstHoverTarget, params.target, mDragSelection.allTabsOnDragReady);
    newUndeterminedRange = newUndeterminedRange.concat(betweenTabs);

    const oldUndeterminedRangeIds = Object.keys(oldUndeterminedRange).map(id => parseInt(id));
    const newUndeterminedRangeIds = newUndeterminedRange.map(tab => tab.id);
    const outOfRangeTabIds = oldUndeterminedRangeIds.filter(id => newUndeterminedRangeIds.indexOf(id) < 0);
    for (const id of outOfRangeTabIds) {
      Selections.set(oldUndeterminedRange[id], !(id in Selections.selection.tabs), {
        globalHighlight: false,
        dontUpdateMenu: true,
        state: params.state
      });
    }

    for (const tab of newUndeterminedRange) {
      if (tab.id in mDragSelection.undeterminedRange)
        continue;
      mDragSelection.undeterminedRange[tab.id] = tab;
      if (oldUndeterminedRangeIds.indexOf(tab.id) > -1)
        continue;
      Selections.set(tab, !(tab.id in Selections.selection.tabs), {
        globalHighlight: false,
        dontUpdateMenu: true,
        state: params.state
      });
    }
  }
  else {
    for (const tab of params.allTargets) {
      mDragSelection.undeterminedRange[tab.id] = tab;
    }
    Selections.set(params.allTargets, !(params.target.id in Selections.selection.tabs), {
      globalHighlight: false,
      dontUpdateMenu: true,
      state: params.state
    });
  }
}


/* select tabs by clicking */

let gInSelectionSession = false;

export async function onTabItemClick(message) {
  if (message.button != 0)
    return false;

  let selected = false;
  {
    if (message.tab.states)
      selected = message.tab.states.indexOf('selected') > -1;
    else
      selected = !!Selections.selection.tabs[message.tab.id];
  }

  const ctrlKeyPressed = message.ctrlKey || (message.metaKey && /^Mac/i.test(navigator.platform));
  if (!ctrlKeyPressed && !message.shiftKey) {
    if (!selected) {
      Selections.clear({
        states: ['selected', 'ready-to-close']
      });
      Selections.selection.clear();
    }
    gInSelectionSession = false;
    Selections.selection.lastClickedTab = null;
    return;
  }

  const lastActiveTab = message.lastActiveTab || (await browser.tabs.query({
    active:   true,
    windowId: message.window
  }))[0];
  if (lastActiveTab)
    TabIdFixer.fixTab(lastActiveTab);

  let tabs = retrieveTargetTabs(message.tab);
  if (message.shiftKey) {
    // select the clicked tab and tabs between last activated tab
    const window = await browser.windows.get(message.window, { populate: true });
    const betweenTabs = getTabsBetween(Selections.selection.lastClickedTab || lastActiveTab, message.tab, window.tabs);
    tabs = tabs.concat(betweenTabs);
    tabs.push(Selections.selection.lastClickedTab || lastActiveTab);
    const selectedTabIds = tabs.map(tab => tab.id);
    if (!ctrlKeyPressed)
      Selections.set(window.tabs.filter(tab => selectedTabIds.indexOf(tab.id) < 0), false, {
        globalHighlight: false
      });
    Selections.set(tabs, true, {
      globalHighlight: false
    });
    gInSelectionSession = true;
    // Selection must include the active tab. This is the standard behavior on Firefox 62 and later.
    const newSelectedTabIds = Selections.getSelectedTabIds();
    if (newSelectedTabIds.length > 0 && !newSelectedTabIds.includes(lastActiveTab.id))
      browser.tabs.update(Selections.selection.lastClickedTab ? Selections.selection.lastClickedTab.id : newSelectedTabIds[0], { active: true });
    return true;
  }
  else if (ctrlKeyPressed) {
    // toggle selection of the tab and all collapsed descendants
    if (message.tab.id != lastActiveTab.id &&
        !gInSelectionSession) {
      Selections.set(lastActiveTab, true, {
        globalHighlight: false
      });
    }
    Selections.set(tabs, !selected, {
      globalHighlight: false
    });
    // Selection must include the active tab. This is the standard behavior on Firefox 62 and later.
    const selectedTabIds = Selections.getSelectedTabIds();
    if (selectedTabIds.length > 0 && !selectedTabIds.includes(lastActiveTab.id))
      browser.tabs.update(selectedTabIds[0], { active: true });
    gInSelectionSession = true;
    Selections.selection.lastClickedTab = message.tab;
    return true;
  }
  return false;
}

export async function onTabItemMouseUp(message) {
  if (message.button != 0)
    return false;

  const ctrlKeyPressed = message.ctrlKey || (message.metaKey && /^Mac/i.test(navigator.platform));
  if (!ctrlKeyPressed &&
      !message.shiftKey &&
      !mDragSelection.dragStartTarget) {
    Selections.clear({
      states: ['selected', 'ready-to-close']
    });
    Selections.selection.clear();;
  }
}

export async function onNonTabAreaClick(message) {
  if (message.button != 0)
    return;
  Selections.clear({
    states: ['selected', 'ready-to-close']
  });
  Selections.selection.clear();;
}


/* select tabs by dragging */

export async function onTabItemDragReady(message) {
  //console.log('onTabItemDragReady', message);
  mDragSelection.undeterminedRange = {};
  Selections.selection.targetWindow = message.window;
  mDragSelection.dragEnteredCount = 1;
  mDragSelection.willCloseSelectedTabs = message.startOnClosebox;
  mDragSelection.pendingTabs = null;
  mDragSelection.dragStartTarget = mDragSelection.firstHoverTarget = mDragSelection.lastHoverTarget = message.tab;
  mDragSelection.allTabsOnDragReady = (await browser.tabs.query({ windowId: message.window })).map(TabIdFixer.fixTab);

  Selections.clear({
    states: ['selected', 'ready-to-close'],
    dontUpdateMenu: true
  });

  const startTabs = retrieveTargetTabs(message.tab);
  Selections.set(startTabs, true, {
    globalHighlight: false,
    dontUpdateMenu: true,
    state: mDragSelection.willCloseSelectedTabs ? 'ready-to-close' : 'selected'
  });

  for (const tab of startTabs) {
    mDragSelection.undeterminedRange[tab.id] = tab;
  }
}

export async function onTabItemDragCancel(message) {
  //console.log('onTabItemDragCancel', message);
  if (Object.keys(Selections.selection.tabs).length > 0) {
    onDragSelectionEnd.dispatch(message);
    // don't clear selection state until menu command is processed.
  }
  mDragSelection.clear();
}

export async function onTabItemDragStart(_message) {
  //console.log('onTabItemDragStart', message);
}

export async function onTabItemDragEnter(message) {
  //console.log('onTabItemDragEnter', message, message.tab == mDragSelection.lastHoverTarget);
  mDragSelection.dragEnteredCount++;
  // processAutoScroll(event);

  if (mDragSelection.lastHoverTarget &&
      message.tab.id == mDragSelection.lastHoverTarget.id)
    return;

  const state = mDragSelection.willCloseSelectedTabs ? 'ready-to-close' : 'selected' ;
  if (mDragSelection.pendingTabs) {
    Selections.set(mDragSelection.pendingTabs, true, {
      globalHighlight: false,
      dontUpdateMenu: true,
      state: state
    });
    mDragSelection.pendingTabs = null;
  }
  /*
  if (mDragSelection.willCloseSelectedTabs || tabDragMode == TAB_DRAG_MODE_SELECT) {
  */
  const targetTabs = retrieveTargetTabs(message.tab);
  toggleStateOfDragOverTabs({
    target:     message.tab,
    allTargets: targetTabs,
    state:      state
  });
  if (message.tab.id == mDragSelection.dragStartTarget.id &&
      Object.keys(Selections.selection.tabs).length == targetTabs.length) {
    Selections.set(targetTabs, false, {
      globalHighlight: false,
      dontUpdateMenu: true,
      state: state
    });
    for (const tab of targetTabs) {
      mDragSelection.undeterminedRange[tab.id] = tab;
    }
    mDragSelection.pendingTabs = targetTabs;
  }
  /*
  }
  else { // TAB_DRAG_MODE_SWITCH:
    browser.tabs.update(message.tab.id, { active: true });
  }
  */
  mDragSelection.lastHoverTarget = message.tab;
  if (!mDragSelection.firstHoverTarget)
    mDragSelection.firstHoverTarget = mDragSelection.lastHoverTarget;
}

export async function onTabItemDragExit(_message) {
  mDragSelection.dragEnteredCount--;
  dragExitAllWithDelay.reserve();
}

function dragExitAllWithDelay() {
  //console.log('dragExitAllWithDelay '+mDragSelection.dragEnteredCount);
  dragExitAllWithDelay.cancel();
  if (mDragSelection.dragEnteredCount <= 0) {
    mDragSelection.firstHoverTarget = mDragSelection.lastHoverTarget = null;
    mDragSelection.undeterminedRange = {};
  }
}
dragExitAllWithDelay.reserve = () => {
  dragExitAllWithDelay.cancel();
  dragExitAllWithDelay.timeout = setTimeout(() => {
    dragExitAllWithDelay();
  }, 10);
};
dragExitAllWithDelay.cancel = () => {
  if (dragExitAllWithDelay.timeout) {
    clearTimeout(dragExitAllWithDelay.timeout);
    delete dragExitAllWithDelay.timeout;
  }
};

export async function onTabItemDragEnd(message) {
  //console.log('onTabItemDragEnd', message);
  if (!configs.autoOpenMenuOnDragEnd)
    return;
  if (mDragSelection.willCloseSelectedTabs) {
    const allTabs = mDragSelection.allTabsOnDragReady.slice(0);
    allTabs.reverse();
    const toBeClosedIds = Selections.getSelectedTabIds();
    for (const tab of allTabs) {
      if (tab && toBeClosedIds.indexOf(tab.id) > -1)
        await browser.tabs.remove(tab.id);
    }
    Selections.clear();
    Selections.selection.clear();
  }
  else if (Object.keys(Selections.selection.tabs).length > 0) {
    onDragSelectionEnd.dispatch(message);
    // don't clear selection state until menu command is processed.
  }
  mDragSelection.clear();
}
