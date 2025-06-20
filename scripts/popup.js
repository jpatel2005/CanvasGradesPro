const isFirefox = navigator.userAgent.toLowerCase().includes('firefox');
const gradeOverlay = document.getElementById('gradeOverlay');
const syncSettingsCheckbox = document.getElementById('sync_settings_checkbox');
const syncSettingsUpload = document.getElementById('sync_settings_upload');
const syncSettingsDownload = document.getElementById('sync_settings_download');
const syncNowButton = document.getElementById('syncNow');
const syncSettingsMessage = document.getElementById('sync_settings_message');
const customFont = document.getElementById('custom_font');
const customFontCheckbox = document.getElementById('custom_font_checkbox');
const setCustomFont = document.getElementById('set_custom_font');
const customFontStyle = document.getElementById('custom_font_style');
const customFontError = document.getElementById('custom_font_error');
const sampleGrade = document.getElementById('sample_grade');
const sampleGradeError = document.getElementById('sample_grade_error');
const textColor = document.getElementById(`text_color${isFirefox ? '_firefox' : ''}`);
const backgroundColor = document.getElementById(`background_color${isFirefox ? '_firefox' : ''}`);
const overlayShowLetterGrade = document.getElementById('dashboard_letter_grade'); 
const showOverlay = document.getElementById('dashboard_grade');
const showGpaCard = document.getElementById('gpa_card');
const gpaCardPosition = document.getElementById('gpa_card_position');
const gradesPageShowClassStats = document.getElementById('show_class_statistics');
const gradesPageShowDrops = document.getElementById('show_drops');
const gradesPageShowGradingStandard = document.getElementById('show_grading_standard');
const contactFormButton = document.getElementById('sendMessage');
const fontStyleDropdown = document.getElementById('fontStyle');
const saveChanges = document.getElementById('saveChanges');
const saveChangesLabel = document.getElementById('saveChangesLabel');
const sendMessageLabel = document.getElementById('sendMessageLabel');
const nameInput = document.getElementById('name');
const messageInput = document.getElementById('message');
const linksContainer = document.getElementById('links');
const webhookURL = 'https://zingy-moonbeam-a2a551.netlify.app/.netlify/functions/api';
const globalConfig = {};
const gradeOverlayConfig = {};
const gpaCardConfig = {};

const hideMessageLabel = function() {
  sendMessageLabel.style.visibility = 'hidden';
  sendMessageLabel.textContent = '';
}
const clearSaveMessage = function() {
  saveChangesLabel.style.visibility = 'hidden';
  saveChangesLabel.textContent = '';
}
const configureCustomFont = async function() {
  await validateCustomFont();
  if (window.customFont === null) {
    return;
  }
  await updateGradeOverlay('custom_font_style');
}
const validateCustomFont = async function() {
  try {
    // Don't do anything if the input is empty or if the toggle switch is off 
    if (customFont.value.trim() === '' || !customFontCheckbox.checked) {
      window.customFont = null;
      return;
    }
    const url = new URL(customFont.value);
    if (url.hostname !== 'fonts.google.com' || !/^\/specimen\/[^\/]+\/?$/.test(url.pathname)) {
      customFontError.style.visibility = 'visible';
      window.customFont = null;
      return;
    }
    const fontFamily = RegExp(/^\/specimen\/([^\/]+)\/?$/).exec(url.pathname)[1].replace(/\+/g, ' ');
    const fontURL = new URL(`https://fonts.googleapis.com/css2`);
    fontURL.searchParams.set('family', fontFamily.replace(/\s/g, '%2b'));
    fontURL.searchParams.set('display', 'swap');
    const response = await fetch(decodeURIComponent(decodeURI(fontURL.href).replace(/\+/g, ' ')));
    // If the response was not ok, this means that the provided font link is invalid (does not lead to a real font)
    if (!response.ok) {
      window.customFont = null;
      customFontError.style.visibility = 'visible';
      return;
    }
    // Set the style block for the custom font
    customFontStyle.textContent = await response.text();
    // Save the custom font family
    window.customFont = fontFamily;
    // Hide the error message
    customFontError.style.visibility = 'hidden';
  } catch (e) {
    customFontError.style.visibility = 'visible';
    window.customFont = null;
  }
}
const getSize = obj => new Blob([JSON.stringify(obj)]).size;

contactFormButton.addEventListener('click', () => {
  const name = nameInput.value.trim();
  const message = messageInput.value.trim();
  if (message === '') {
    sendMessageLabel.style.visibility = 'visible';
    sendMessageLabel.style.color = 'red';
    sendMessageLabel.textContent = "Please fill out the message field!";
    return;
  } else if (message.length >= 1024) {
    sendMessageLabel.style.visibility = 'visible';
    sendMessageLabel.style.color = 'red';
    sendMessageLabel.textContent = "Your message is too long!";
    return;
  }
  fetch(webhookURL, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({ name, message }),
  })
  .then(response => {
    if (response.ok) {
      sendMessageLabel.style.visibility = 'visible';
      sendMessageLabel.style.color = 'black';
      sendMessageLabel.textContent = "Message sent successfully!";
      nameInput.value = '';
      messageInput.value = '';
    } else {
      sendMessageLabel.style.visibility = 'visible';
      sendMessageLabel.style.color = 'red';
      sendMessageLabel.textContent = "Message failed to send!";
    }
  });
});
saveChanges.addEventListener('click', async () => {
  if (customFontCheckbox.checked) {
    await validateCustomFont();
    // If the custom font is bad, then abandon the save
    if (window.customFont === null) {
      saveChangesLabel.style.visibility = 'visible';
      saveChangesLabel.style.color = 'red';
      saveChangesLabel.textContent = "Changes failed to save!";
      return;
    }
  }
  gradeOverlayConfig.text_color = isFirefox ? textColor.dataset.currentColor : textColor.value;
  gradeOverlayConfig.background_color = isFirefox ? backgroundColor.dataset.currentColor : backgroundColor.value;
  gradeOverlayConfig.font_style = fontStyleDropdown.value;
  gradeOverlayConfig.show_letter_grade = overlayShowLetterGrade.checked;
  gradeOverlayConfig.show_overlay = showOverlay.checked;
  // Only save custom font if the custom font provided is not null
  await validateCustomFont();
  if (window.customFont !== null) {
    gradeOverlayConfig.custom_font = customFont.value.trim();
    gradeOverlay.style.fontFamily = window.customFont;
  }
  gradeOverlayConfig.use_custom_font = customFontCheckbox.checked;
  gpaCardConfig.show_card = showGpaCard.checked;
  gpaCardConfig.position = gpaCardPosition.value;
  globalConfig.class_statistics_default_view = gradesPageShowClassStats.checked;
  globalConfig.grading_standard_default_view = gradesPageShowGradingStandard.checked;
  globalConfig.drops_default_view = gradesPageShowDrops.checked;
  globalConfig.always_sync = syncSettingsCheckbox.checked;
  try {
    await chrome.storage.local.set(globalConfig);
    await chrome.storage.local.set({ gpa_card: gpaCardConfig });
    await chrome.storage.local.set({ grade_overlay: gradeOverlayConfig });
    if (globalConfig.always_sync) {
      delete globalConfig.always_sync;
      await chrome.storage.sync.set(globalConfig);
      globalConfig.always_sync = syncSettingsCheckbox.checked;
      await chrome.storage.sync.set({ gpa_card: gpaCardConfig });
      await chrome.storage.sync.set({ grade_overlay: gradeOverlayConfig });
    }
  } catch (err) {
    saveChangesLabel.style.visibility = 'visible';
    saveChangesLabel.style.color = 'red';
    saveChangesLabel.textContent = "Changes failed to save!";
  }
  saveChangesLabel.style.visibility = 'visible';
  saveChangesLabel.style.color = 'black';
  saveChangesLabel.textContent = "Changes saved successfully!";
});
nameInput.addEventListener('input', hideMessageLabel);
messageInput.addEventListener('input', hideMessageLabel);
// Add event listeners for configuring the grade overlay preview
sampleGrade.addEventListener('input', async () => await updateGradeOverlay('grade'));
overlayShowLetterGrade.addEventListener('input', async () => await updateGradeOverlay('letter_grade'));
// Use the correct method for detecting changes in the color input (firefox uses MutationObserver and everything else uses an eventListener)
if (isFirefox) {
  const observer = new MutationObserver(async (mutationList, _observer) => {
    for await (const mutation of mutationList) {
      await updateGradeOverlay(mutation.target.id.replace('_firefox', ''));
    }
  });
  observer.observe(textColor, { attributeFilter: ['data-current-color'] });
  observer.observe(backgroundColor, { attributeFilter: ['data-current-color'] });
} else {
  textColor.addEventListener('input', async () => await updateGradeOverlay('text_color'));
  backgroundColor.addEventListener('input', async () => await updateGradeOverlay('background_color'));
}
customFontCheckbox.addEventListener('change', async () => {
  // If the custom font switch is off, then disable the custom font input
  // Or else, perform the same actions as pressing the (refresh-icon) button for setting the custom font 
  if (!customFontCheckbox.checked) {
    customFont.disabled = true;
    setCustomFont.disabled = true;
    customFontError.style.visibility = 'hidden';
    await updateGradeOverlay('font_style');
  } else {
    customFont.disabled = false;
    setCustomFont.disabled = false;
    await configureCustomFont();
    customFontError.style.visibility = window.customFont === null ? 'visible' : 'hidden';
  }
});
setCustomFont.addEventListener('click', async () => await configureCustomFont());
customFont.addEventListener('keydown', async (event) => {
  if (event.key === 'Enter') {
    await configureCustomFont();
  }
})
fontStyleDropdown.addEventListener('change', async () => await updateGradeOverlay('font_style'));
// Add event listeners for updating the save text when interacting with the class config
gradesPageShowGradingStandard.addEventListener('input', clearSaveMessage);
gradesPageShowClassStats.addEventListener('input', clearSaveMessage);
gradesPageShowDrops.addEventListener('input', clearSaveMessage);
linksContainer.firstElementChild.addEventListener('click', () => chrome.tabs.create({ url: 'https://github.com/jpatel2005/CanvasGradesPro/issues' }));
linksContainer.lastElementChild.addEventListener('click', () => chrome.tabs.create({ url: 'https://forms.gle/CVf8hfLLBRYCzLhp7' }));
syncNowButton.addEventListener('click', async () => {
  if (!syncSettingsDownload.checked && !syncSettingsUpload.checked) {
    syncSettingsMessage.classList.add('error');
    syncSettingsMessage.textContent = 'Please select "Upload" or "Download"!';
    return;
  }
  if (syncSettingsDownload.checked) {
    // Download mode (replace local storage with sync storage)
    try {
      const syncStorage = await chrome.storage.sync.get();
      await chrome.storage.local.set(syncStorage);
      syncSettingsMessage.classList.remove('error');
      syncSettingsMessage.textContent = 'Sync download successful! Refresh to see changes';
    } catch (err) {
      syncSettingsMessage.classList.add('error');
      syncSettingsMessage.textContent = 'Sync download failed!';
      console.error(err);
    }
  } else {
    // Upload mode (replace sync storage with local storage)
    const localStorage = await chrome.storage.local.get();
    const validStorage = {};
    const keysToClear = [];
    for (const [key, value] of Object.entries(localStorage)) {
      if (key === 'always_sync') {
        continue;
      }
      const itemSize = getSize({ [key] : value });
      // If size is greater than 8 KB, then we cannot upload it to sync storage
      if (itemSize > 8 * 1024) {
        keysToClear.push(key);
        continue;
      }
      validStorage[key] = value;
    }
    // Check the size limitations
    const totalSize = getSize(validStorage);
    if (totalSize > 100 * 1024) {
      syncSettingsMessage.classList.add('error');
      syncSettingsMessage.textContent = 'Sync upload failed! Size exceeds 100 KB';
      return;
    }
    if (keysToClear.length > 0) {
      syncSettingsMessage.classList.remove('error');
      syncSettingsMessage.textContent = `Sync upload successful! Keys that failed to sync: ${keysToClear.join(',')}`;
    } else {
      syncSettingsMessage.classList.remove('error');
      syncSettingsMessage.textContent = 'Sync upload successful!';
    }
    try {
      await chrome.storage.sync.remove(keysToClear);
      await chrome.storage.sync.set(validStorage);
    } catch (err) {
      syncSettingsMessage.classList.add('error');
      syncSettingsMessage.textContent = 'Sync upload failed!';
      console.error(err);
    }
  }
});
document.addEventListener('DOMContentLoaded', async () => {
  const obj = await chrome.storage.local.get();
  const overlayConfig = obj.grade_overlay ?? {};
  const cardConfig = obj.gpa_card ?? {};
  // Set popup border color using primary color (same color as Canvas)
  document.body.style.backgroundColor = obj.primary_color ?? '#990000';
  // Display alternative color inputs if firefox is the current browser (normal color input closes the input for firefox)
  // Or just configure the default value normally if firefox is not the current browser
  if (isFirefox) {
    document.getElementById('text_color').style.display = 'none';
    document.getElementById('background_color').style.display = 'none';
    textColor.style.display = 'inline-block';
    backgroundColor.style.display = 'inline-block';
    // Load default values & configurations for the color pickers
    new JSColor(textColor, {
      position: "top",
      value: overlayConfig.text_color ?? "#ffffff"
    });
    new JSColor(backgroundColor, {
      position: "top",
      value: overlayConfig.background_color ?? "#000000"
    });
  } else {
    textColor.value = overlayConfig.text_color ?? "#ffffff";
    backgroundColor.value = overlayConfig.background_color ?? "#000000";
  }
  // Configure the remaining grade overlay settings 
  fontStyleDropdown.value = overlayConfig.font_style ?? 'Cursive'; // Font style dropdown
  customFont.value = overlayConfig.custom_font ?? ''; // Custom font textbox (don't save if font is invalid)
  customFontCheckbox.checked = overlayConfig.use_custom_font ?? false; // Custom font toggle switch
  // Disable custom font textbox (and refresh button) if the toggle switch is off
  customFont.disabled = !customFontCheckbox.checked;
  setCustomFont.disabled = !customFontCheckbox.checked;
  overlayShowLetterGrade.checked = overlayConfig.show_letter_grade ?? true; // Letter grade display checkbox
  showOverlay.checked = overlayConfig.show_overlay ?? true; // Overlay display checkbox
  // Configure the course page settings (also copy course page config to globalConfig variable)
  gradesPageShowClassStats.checked = globalConfig.class_statistics_default_view = obj.class_statistics_default_view ?? true;
  gradesPageShowGradingStandard.checked = globalConfig.grading_standard_default_view = obj.grading_standard_default_view ?? true;
  gradesPageShowDrops.checked = globalConfig.drops_default_view = obj.drops_default_view ?? true;
  // Configure sync settings
  syncSettingsCheckbox.checked = globalConfig.always_sync = obj.always_sync ?? false;
  // Configure the gpa card settings
  showGpaCard.checked = cardConfig.show_card ?? true; // GPA card display checkbox
  gpaCardPosition.value = cardConfig.position ?? 'first'; // GPA card position dropdown (possible values are 'first', 'last')
  // Copy overlay config to config variable
  Object.assign(gradeOverlayConfig, overlayConfig);
  Object.assign(gpaCardConfig, cardConfig);
  for (const fontStyleOption of fontStyleDropdown.children) {
    fontStyleOption.style.fontFamily = fontStyleOption.textContent;
  }
  await updateGradeOverlay(null);
});

const default_grading_standard = {
  97: 'A+',
  93: 'A',
  90: 'A-',
  87: 'B+',
  83: 'B',
  80: 'B-',
  77: 'C+',
  73: 'C',
  70: 'C-',
  67: 'D+',
  63: 'D',
  60: 'D-',
  0: 'F', // everything else is a F
}
const getLetterGrade = function(grade) {
    if (grade < 0) {
    return 'N/A';
  }
  // Default grading scheme (sorting in descending order)
  const weights = Object.keys(default_grading_standard).map(Number);
  // Binary search on the weights
  let left = 0, right = weights.length - 1;
  while (left <= right) {
    const mid = Math.floor((left + right) / 2);
    const rightMid = weights[mid+1] ?? Infinity;
    if (grade >= weights[mid] && grade < rightMid) {
      return default_grading_standard[weights[mid]];
    } else if (grade < weights[mid]) {
      right = mid - 1;
    } else {
      left = mid + 1;
    }
  }
  return 'N/A';
}
const updateGradeOverlay = async function(change) {
  saveChangesLabel.style.visibility = 'hidden';
  // If change is null, then update everything (used for intial configuration)
  if (change === null) {
    const grade = validateGrade(sampleGrade.value);
    if (grade === null) {
      return;
    }
    if (customFontCheckbox.checked) {
      await configureCustomFont();
    }
    fontStyleDropdown.style.fontFamily = fontStyleDropdown.value;
    gradeOverlay.style.fontFamily = window.customFont ?? fontStyleDropdown.value;
    gradeOverlay.style.color = isFirefox ? textColor.dataset.currentColor : textColor.value;
    gradeOverlay.style.backgroundColor = isFirefox ? backgroundColor.dataset.currentColor : backgroundColor.value;
    gradeOverlay.textContent = `${grade}%${overlayShowLetterGrade.checked ? `\u0020(${getLetterGrade(grade)})` : ''}`
  }
  if (change === 'custom_font_style') {
    gradeOverlay.style.fontFamily = window.customFont;  
  } else if (change === 'font_style') {
    fontStyleDropdown.style.fontFamily = fontStyleDropdown.value;
    if (!customFontCheckbox.checked) {
      gradeOverlay.style.fontFamily = fontStyleDropdown.value;
    }
  } else if (change === 'text_color') {
    gradeOverlay.style.color = isFirefox ? textColor.dataset.currentColor : textColor.value;
  } else if (change === 'background_color') {
    gradeOverlay.style.backgroundColor = isFirefox ? backgroundColor.dataset.currentColor : backgroundColor.value;
  } else if (change === 'grade' || change === 'letter_grade') {
    const grade = validateGrade(sampleGrade.value);
    if (grade !== null) {
      gradeOverlay.textContent = `${grade}%${overlayShowLetterGrade.checked ? `\u0020(${getLetterGrade(grade)})` : ''}`
    }
  }
}
const validateGrade = function(input) {
  input = input.trim();
  const grade = input !== '' && /^(\d+)?\.?(\d+)?$/.test(input) ? +input : null;
  // Bad grade input
  if (grade === null) {
    sampleGradeError.style.visibility = 'visible';
    return null;
  }
  sampleGradeError.style.visibility = 'hidden';
  return grade;
}