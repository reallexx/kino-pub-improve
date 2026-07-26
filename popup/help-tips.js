(() => {
  const FLOATING_TIP_CLASS = 'help-tip-floating';
  const VIEWPORT_PADDING_PX = 8;
  const GAP_PX = 6;

  let floatingTipElement = null;
  let activeHelpTipElement = null;

  function ensureFloatingTipElement() {
    if (floatingTipElement && floatingTipElement.isConnected) {
      return floatingTipElement;
    }

    floatingTipElement = document.createElement('div');
    floatingTipElement.className = FLOATING_TIP_CLASS;
    floatingTipElement.setAttribute('role', 'tooltip');
    floatingTipElement.hidden = true;
    document.body.appendChild(floatingTipElement);
    return floatingTipElement;
  }

  function hideFloatingTip() {
    if (!floatingTipElement) {
      return;
    }

    floatingTipElement.hidden = true;
    floatingTipElement.textContent = '';
    activeHelpTipElement = null;
  }

  function positionFloatingTip(helpTipElement) {
    const tipElement = ensureFloatingTipElement();
    const tipText = helpTipElement.getAttribute('data-tip') || '';
    if (!tipText) {
      hideFloatingTip();
      return;
    }

    tipElement.hidden = false;
    tipElement.textContent = tipText;
    activeHelpTipElement = helpTipElement;

    const iconRect = helpTipElement.getBoundingClientRect();
    const tipRect = tipElement.getBoundingClientRect();
    const viewportWidth = window.innerWidth;
    const viewportHeight = window.innerHeight;

    let left = iconRect.left;
    let top = iconRect.bottom + GAP_PX;

    if (left + tipRect.width > viewportWidth - VIEWPORT_PADDING_PX) {
      left = viewportWidth - VIEWPORT_PADDING_PX - tipRect.width;
    }

    if (left < VIEWPORT_PADDING_PX) {
      left = VIEWPORT_PADDING_PX;
    }

    if (top + tipRect.height > viewportHeight - VIEWPORT_PADDING_PX) {
      top = iconRect.top - GAP_PX - tipRect.height;
    }

    if (top < VIEWPORT_PADDING_PX) {
      top = VIEWPORT_PADDING_PX;
    }

    tipElement.style.left = `${Math.round(left)}px`;
    tipElement.style.top = `${Math.round(top)}px`;
  }

  function bindHelpTip(helpTipElement) {
    const tipText = helpTipElement.getAttribute('data-tip') || '';
    if (!tipText) {
      return;
    }

    // Native title как fallback, если JS не успел/сломался.
    if (!helpTipElement.getAttribute('title')) {
      helpTipElement.setAttribute('title', tipText);
    }

    const showTip = () => {
      // Убираем native title на время hover, чтобы не дублировать.
      helpTipElement.setAttribute('data-native-title', tipText);
      helpTipElement.removeAttribute('title');
      positionFloatingTip(helpTipElement);
    };

    const hideTip = () => {
      const nativeTitle = helpTipElement.getAttribute('data-native-title');
      if (nativeTitle) {
        helpTipElement.setAttribute('title', nativeTitle);
        helpTipElement.removeAttribute('data-native-title');
      }
      hideFloatingTip();
    };

    helpTipElement.addEventListener('mouseenter', showTip);
    helpTipElement.addEventListener('focus', showTip);
    helpTipElement.addEventListener('mouseleave', hideTip);
    helpTipElement.addEventListener('blur', hideTip);
  }

  function initHelpTips() {
    document.querySelectorAll('.help-tip[data-tip]').forEach(bindHelpTip);

    window.addEventListener('scroll', () => {
      if (activeHelpTipElement) {
        positionFloatingTip(activeHelpTipElement);
      }
    }, true);

    window.addEventListener('resize', hideFloatingTip);
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', initHelpTips);
  } else {
    initHelpTips();
  }
})();
