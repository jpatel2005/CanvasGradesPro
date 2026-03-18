// Check if an object is empty 
// Note: Returns true if the object is null or undefined
const isObjectEmpty = function(obj) {
  if (obj === null || obj === undefined) {
    return true;
  }
  for (const _prop in obj) {
    return false;
  }
  return true;
}

const getSize = obj => new Blob([JSON.stringify(obj)]).size;

// Function for abstracting the config saving process
const saveConfig = async function(config, key) {
  try {
    // Save to local storage first
    await chrome.storage.local.set({ [key] : config });
    const always_sync = (await chrome.storage.local.get('always_sync'))?.always_sync ?? false;
    // Exit early if we are not using sync storage or if the key is "always_sync" (do not save this key to sync storage)
    if (!always_sync || key === 'always_sync') {
      return;
    }
    // Attempt to save to sync storage
    const itemSize = getSize({ [key] : config });
    if (itemSize > 8 * 1024) {
      console.error(`Cannot save ${key} to sync storage. Larger than 8 KB`, config);
      return;
    }
    await chrome.storage.sync.set({ [key] : config });
  } catch (err) {
    console.error('Save to sync storage failed!', err);
  }
}

// Function for retrieving config while accounting for whether sync storage is being used
const getConfig = async function() {
  try {
    const localConfig = await chrome.storage.local.get();
    const getSync = localConfig?.always_sync ?? false;
    if (getSync) {
      const syncConfig = await chrome.storage.sync.get();
      for (const [key, value] of Object.entries(syncConfig)) {
        localConfig[key] = value;
      }
    }
    return localConfig;
  } catch (err) {
    console.error('Error when fetching config', err);
    return {};
  }
}

// Numbers represent the lower limit for a given letter grade
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
};
// Standard for how letter grades are converted to GPA (this standard is for UMD)
const default_gpa_standard = {
  'A+': 4.0,
  'A': 4.0,
  'A-': 3.7,
  'B+': 3.3,
  'B': 3.0,
  'B-': 2.7,
  'C+': 2.3,
  'C': 2.0,
  'C-': 1.7,
  'D+': 1.3,
  'D': 1.0,
  'D-': 0.7,
  'F': 0.0
};

/**
 * Function for finding the variance of an array of letter grades
 * Uses the formula: Var(X) = (1/n) * sum of (x_i - u)^2 = [(1/n) * sum of (x_i)^2] - [(1/n) * sum of x_i]^2 
 * Used for finding the most "realistic" min gpa combinations
 */
const findVariance = function(gpaStandard, grades) {
  const n = grades.length;
  if (n === 0) {
    return 0;
  }
  let sum = 0;
  let sumOfSquares = 0;
  for (let i = 0; i < n; i++) {
    const val = Number(gpaStandard[grades[i]]);
    sum += val;
    sumOfSquares += (val*val);
  }
  const mean = sum / n;
  return (sumOfSquares / n) - (mean * mean);
}

// Determine adjusted drop values, if necessary
// Low drops take priority over high drops (e.g. 2 assignments, 1 low & 1 high drop -> low drop will be applied, high drop will not)
const validateDropCounts = function(lowDrops, highDrops, totalAssignments) {
  // Check if adjustment is necessary
  if (lowDrops + highDrops < totalAssignments) {
    return [lowDrops, highDrops];
  }
  // Drops must leave at least one assignment remaining
  const newLowDrops = Math.max(Math.min(lowDrops, totalAssignments-1), 0);
  const newHighDrops = Math.max(Math.min(highDrops, totalAssignments-1-newLowDrops), 0);
  return [newLowDrops, newHighDrops];
}

/**
 * Function for calculating possible combinations for your desired minimum gpa
 * Queue-based approach with duplicate prevention
 * gpaStandard: Letter grade to gpa points mapping
 * courseCredits: Array of credits (will be sorted in the function for a standard return format)
 * gpaRequired: Numeric value representing the gpa required for the current semester
*/
const getMinGpaCombinations = function(gpaStandard, courseCredits, gpaRequired) {
  courseCredits.sort((a,b) => b-a);
  const sortedGpaStandard = Object.keys(gpaStandard).sort((a, b) => {
    // If the GPA's associated with the two current letter grades are not equal, then compare them
    if (gpaStandard[a] !== gpaStandard[b]) {
      return gpaStandard[b] - gpaStandard[a];
    }
    // If they are equal, then compare the letter grade representations (while considering plus and minus signs)
    return (b + ',').localeCompare(a + ',');
  });
  // Modify the keys so that the non-unique keys are "filtered" out (this will be sorted is descending order)
  const gpaStandardKeys = [];
  for (let i = 0; i < sortedGpaStandard.length; i++) {
    // If the next letter grade maps to the same gpa as the current letter grade, then skip the current letter grade
    const flag = i < sortedGpaStandard.length-1 && gpaStandard[sortedGpaStandard[i]] === gpaStandard[sortedGpaStandard[i+1]];
    if (flag) {
      continue;
    }
    gpaStandardKeys.push(sortedGpaStandard[i]);
  }
  // Convert GPAs to integers (x100) to minimize floating point bugs
  const gpaScaled = {};
  for (const key of gpaStandardKeys) {
    gpaScaled[key] = Math.round(100 * gpaStandard[key]); 
  }
  const requiredGpaScaled = Math.round(100 * gpaRequired);
  const maxGpaScaled = gpaScaled[gpaStandardKeys[0]];
  const totalCredits = courseCredits.reduce((a,b) => a+b, 0);
  // Determine the maximum error that will allowed
  // This will fail in the following case:
  // The max gpa cannot be obtained by simply by getting the highest grade in all your courses (e.g. honors and AP courses)
  const maxErrorScaled = totalCredits * (maxGpaScaled - requiredGpaScaled);
  // Keep track of the maximum error difference allowed
  let maxErrorDiffScaled = 100;
  let validResults = null;
  while (true) {
    // Don't add something to the queue if it will fail when processed (do some preprocessing to minimize memory usage and improve performance)
    let queue = [[0,[]]]; // format: [ current_error_scaled, array_of_letter_grades ]
    for (let i = 0; i < courseCredits.length; i++) {
      const credits = courseCredits[i];
      // Build new queue as you go (avoid slow removal and high memory usage)
      const nextQueue = [];
      // Check if the current course has the same credits as the previous one
      const isSameCreditsAsPrev = i > 0 && courseCredits[i] === courseCredits[i-1];
      for (let j = 0; j < queue.length; j++) {
        const currError = queue[j][0];
        const currGrades = queue[j][1];
        // If same credit, start at grade index of the previous course
        // Can avoid generating duplicate permutations with this approach
        let startGradeIdx = 0;
        if (isSameCreditsAsPrev) {
          const prevGrade = currGrades[i-1];
          startGradeIdx = gpaStandardKeys.indexOf(prevGrade);
        }
        for (let k = startGradeIdx; k < gpaStandardKeys.length; k++) {
          const letterGrade = gpaStandardKeys[k];
          const deltaError = credits * (maxGpaScaled - gpaScaled[letterGrade]);
          const newError = currError + deltaError;
          // Check if the error is too large (if so, then don't add to the queue)
          if (newError > maxErrorScaled) {
            break;
          }
          // If this is the final error check, then check to make sure that the error as close as possible to the maximum error 
          // Check if error is too small (GPA too high)
          if (i === courseCredits.length-1 && maxErrorScaled - newError >= maxErrorDiffScaled) {
            continue; 
          }
          // Push the new state to the queue (should be permutation-free)
          nextQueue.push([newError, [...currGrades, letterGrade]]);
        }
      }
      queue = nextQueue;
    }
    validResults = queue;
    // If the number is results is at least 10 or if we have tried this enough times, then return the results
    if (validResults.length >= 10 || maxErrorDiffScaled > (maxGpaScaled * courseCredits.length)) {
      validResults.sort((a,b) => findVariance(gpaStandard, a[1]) - findVariance(gpaStandard, b[1]));
      return validResults.slice(0, 50).map(result => {
        const grades = result[1];
        // Unflatten the array; convert to object format
        return grades.reduce((acc, grade, idx) => {
          const credits = courseCredits[idx];
          if (acc[credits] === undefined) {
            acc[credits] = [];
          }
          acc[credits].push(grade);
          return acc;
        }, {});
      });
    }
    // Increment the error (to allow more grades to satisfy the given conditions)
    maxErrorDiffScaled += 50;
  }
}
const applyCustomFont = async function(font) {
  try {
    // Don't do anything if the input is empty or if the toggle switch is off 
    if (font.trim() === '') {
      window.customFont = null;
      return;
    }
    const url = new URL(font);
    if (url.hostname !== 'fonts.google.com' || !/^\/specimen\/[^\/]+\/?$/.test(url.pathname)) {
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
      return;
    }
    const customFontStyle = document.getElementById('custom_font_style') ?? document.createElement('style');
    if (customFontStyle.id === '') {
      customFontStyle.id = 'custom_font_style';
      document.head.appendChild(customFontStyle);
    }
    // Set the style block for the custom font
    customFontStyle.textContent = await response.text();
    // Save the custom font family
    window.customFont = fontFamily;
  } catch (e) {
    window.customFont = null;
  }
}

// Dashboard page
if (document.title === 'Dashboard') {
  window.maxActiveSemesterId = -1;
  window.maxActiveSemesterName = -1;
  fetch('/api/v1/dashboard/dashboard_cards', {
    method: 'GET'
  })
  .then(response => response.json())
  .then(cards => {
    return Promise.all(cards.map(async card => {
      const course = await (await fetch(`api/v1/courses/${card.id}?include[]=term`, {
        method: 'GET'
      })).json();
      if (course.term !== undefined && window.maxActiveSemesterId < course.term.id) {
        window.maxActiveSemesterId = course.term.id;
        window.maxActiveSemesterName = course.term.name;
      }
      return {
        id: card.id,
        course_code: card.courseCode,
        apply_assignment_group_weights: course.apply_assignment_group_weights,
        grading_standard_id: course.grading_standard_id
      }
    }));
  })
  .catch(err => {
    // Probably not on a Canvas page, so stop the execution of this code
    console.error('An error has occurred when fetching dashboard cards', err);
    thisFunctionDoesNotExistAndWasCreatedWithTheOnlyPurposeOfStopJavascriptExecutionOfAllTypesIncludingCatchAndAnyArbitraryWeirdScenario();
  })
  .then(async courses => {
    // Listen for updating grade overlays when the settings are updated using the popup
    chrome.storage.onChanged.addListener(async (changes, _namespace) => {
      for await (const [key, { newValue: config }] of Object.entries(changes)) {
        // If the storage update was not for the grade overlay OR not for the gpa card, then ignore it
        if (key !== 'grade_overlay' && key !== 'gpa_card') {
          continue;
        }
        // If the storage update was for the gpa card, then handle that then exit
        if (key === 'gpa_card') {
          // code here
          // Check if the gpa card is being hidden
          const gpaCard = document.querySelector('.ic-DashboardCard:has(> #canvas-grades-pro-gpa-calculator)');
          if (gpaCard === null) {
            console.error('GPA card does not exist');
          }
          const hidingCard = config.show_card === false;
          // If we are hiding the gpa card, then set the display to none before continuing
          if (hidingCard) {
            gpaCard.style.display = 'none';
            continue;
          }
          // Or else reset the display to the original
          gpaCard.style.display = '';
          const currentState = gpaCard.previousElementSibling === null ? 'first' : 'last';
          // If the current position of the gpa card is what is being set, then do nothing
          if (currentState === config.position) {
            continue;
          }
          if (config.position === 'first') {
            gpaCard.parentElement.prepend(gpaCard);
          } else if (config.position === 'last') {
            gpaCard.parentElement.appendChild(gpaCard);
          }
          continue;
        }
        // Get all of the grade overlays
        const gradeOverlays = document.getElementById('DashboardCard_Container').querySelectorAll('.grade_overlay');
        // Check if the grade overlays are being hidden
        const hidingOverlays = config.show_overlay === false;
        for (const gradeOverlay of gradeOverlays) {
          // If we are hiding the grade overlays, then set the display to none before continuing 
          if (hidingOverlays) {
            gradeOverlay.style.display = 'none';
            continue;
          }
          // Or else reset the display to the original
          gradeOverlay.style.display = 'block';
          // Access grade and letter grade from dataset map (avoid DOM parsing and any unnecessary recalculations)
          const { grade, letterGrade } = gradeOverlay.dataset;
          // Update styling for the grade overlays
          gradeOverlay.style.backgroundColor = config.background_color;
          gradeOverlay.style.color = config.text_color;
          if (config.use_custom_font) {
            await applyCustomFont(config.custom_font ?? '');
          }
          gradeOverlay.style.fontFamily = config.use_custom_font ? window.customFont ?? config.font_style : config.font_style;
          gradeOverlay.textContent = grade === 'NG' ? `No Grade ${config.show_letter_grade ? '(NG)' : ''}` : `${grade}%`;
          // Show the letter grade on the display if configured
          if (letterGrade !== 'null' && config.show_letter_grade) {
            gradeOverlay.textContent += `\u2004(${letterGrade})`; 
          }
        }
      }
    });
    // Get all config settings from storage
    const config = await getConfig();
    // Cleanup bad config data
    if (config.undefined !== undefined) {
      await chrome.storage.local.remove(['undefined']);
      await chrome.storage.sync.remove(['undefined']);
    }
    // Store the primary color (used for customizing the popup)
    if (config.primary_color === undefined) {
      config.primary_color = getComputedStyle(document.body).getPropertyValue('--dt-color-primary');
      await saveConfig(config.primary_color, 'primary_color');
      // await saveConfig({ primary_color: config.primary_color }, null);
    }
    // Return config for the current course and the global config
    return [courses, config];
  })
  .then(async ([courses,config]) => {
    // Get the container for all of the dashboard cards
    const cardsContainer = document.getElementById('DashboardCard_Container').children[0].children[0];
    // Store grades that are computed for the grade overlay (to prevent re-calculation) - Format: { course_id : [course_grade, course_letter_grade] }
    window.computedGrades = {};
    // Map all of the courses to the grades in that course
    const gradePromises = courses.map(async (course, index) => {
      // Attempt to get the card for the current course
      const card = cardsContainer.querySelector(`a[href='/courses/${course.id}']`)?.parentElement ?? null;
      if (card === null) {
        courses[index] = null;
        return null;
      }  
      try {
        // Get the config for the current class (default to an empty object if the current class has no config)
        const classConfig = config[course.id] ?? {};
        const overlayConfig = config.grade_overlay ?? {};
        // Get the grade for the current class (using config and class grading standard if available)
        const grade = (await getCourseGrade(courses[index], classConfig, null, null, false))[0];
        // Use the default grading standard if the current class has no grading standard
        if (isObjectEmpty(classConfig.grading_standard)) {
          classConfig.grading_standard = course.grading_standard_id !== null && course.grading_standard_id !== undefined ? ((await retrieveGradingStandard(course.id, course.grading_standard_id)) ?? config.default_grading_standard ?? default_grading_standard) : config.default_grading_standard ?? default_grading_standard;
        }
        // Get the letter grade for the current course
        const letterGrade = await getLetterGrade(classConfig.grading_standard, grade);
        const gradeOverlay = document.createElement('a');
        gradeOverlay.href = `/courses/${course.id}/grades`;
        // Style the grade overlay using config (or use default values if there isn't any)
        gradeOverlay.style.position = 'absolute';
        gradeOverlay.style.marginLeft = '.7em';
        gradeOverlay.style.marginTop = '.7em';
        gradeOverlay.style.padding = '2px 6px 2px';
        gradeOverlay.style.borderRadius = '5px';
        gradeOverlay.style.zIndex = 1;
        gradeOverlay.style.display = 'none';
        gradeOverlay.style.backgroundColor = overlayConfig.background_color ?? 'black';
        gradeOverlay.style.color = overlayConfig.text_color ?? 'white';
        if (overlayConfig.use_custom_font) {
          await applyCustomFont(overlayConfig.custom_font ?? '');
        }
        gradeOverlay.style.fontFamily = overlayConfig.use_custom_font ? window.customFont ?? (overlayConfig.font_style ?? 'cursive') : overlayConfig.font_style ?? 'cursive';
        gradeOverlay.textContent = grade === 'NG' ? 'No Grade (NG)' : `${grade}%`;
        gradeOverlay.dataset.grade = grade;
        gradeOverlay.dataset.letterGrade = letterGrade;
        // Show the letter grade on the display if configured
        if (letterGrade !== null && (overlayConfig.show_letter_grade ?? true)) {
          gradeOverlay.textContent += `\u2004(${letterGrade})`; 
        }
        gradeOverlay.classList.add('grade_overlay');
        card.prepend(gradeOverlay);
        // TODO Consider removing the letter grade since it is not being used
        window.computedGrades[course.id.toString()] = [grade, letterGrade];
        return grade;
      } catch (err) {
        console.error(`Failed to get grade for course ${course.id}:`, err);
        return null;
      }
    });
    // Wait for all of the grades to be set before continuing
    await Promise.all(gradePromises);
    return config;
  })
  .then(config => {
    const hidingOverlays = config.grade_overlay?.show_overlay === false;
    // Do not show the grade overlay if the config is set to hide overlays
    if (hidingOverlays) {
      return config;
    }
    // Grades overlays were all configured, so show them all at once (they are not being hidden)
    document.querySelectorAll('.grade_overlay').forEach(gradeOverlay => {
      gradeOverlay.style.display = 'block';
    });
    return config;
  })
  .then(async config => {
    // GPA Calculator
    const customStyling = document.createElement('style');
    customStyling.textContent = `
    .ic-DashboardCard:has(#canvas-grades-pro-gpa-calculator) {
      width: 320px;
    }

    #canvas-grades-pro-gpa-calculator {
      margin-top: 20px;
      // padding: 47.5px;
      padding: 20px;
      border-radius: 8px;
      background-color: white;
      box-shadow: 0 2px 4px rgba(0, 0, 0, 0.3);
      text-align: center;
      font-family: Arial, sans-serif;
      position: relative;
      user-select : none;
      -moz-user-select: none;
      margin-top: 0;

      .gpa-title {
        font-size: 18px;
        font-weight: bold;
        margin-top: 6px;
        margin-bottom: -4px;
        color: #333;
      }

      #first-gpa-title.gpa-title {
        margin-top: 12px;
      }

      .gpa-value {
        font-size: 38px;
        font-weight: bold;
        margin-bottom: 4px;
        color: #333;
      }

      .credits-value {
        font-size: .7rem;
        margin-top: -.7rem;
        font-family: Trebuchet MS, sans-serif;
      }

      #gpa-semester-subcontainer, #gpa-cumulative-subcontainer {
        display: inline-flex;
        flex-direction: row-reverse;
        align-items: center;
        gap: 6px;
      }

      #gpa-semester-subcontainer > i:hover {
        cursor: pointer;
      }
        
      #gpa-cumulative-subcontainer {
        height: 1.5rem;
        gap: 0;
      }

      #gpa-cumulative-subcontainer > div:not(.switch-container) {
        font-size: .675rem;
      }

      #gpa-cumulative-subcontainer > div.switch-container {
        transform: scale(0.5);
        margin-left: -.5rem;
      }

      .gpa-value.blurred {
        text-shadow: 0 0 24px black;
        color: transparent;
      }

      .gpa-error-message {
        font-size: .8rem;
        color: red;
        font-weight: bold;
        margin: 10px 0;
      }

      #gpa-button-container {
        display: flex;
        flex-direction: row;
        gap: 6px;
        width: 106%;
        margin-left: -3%;
      }

      #gpa-button-container i.fa-question-circle {
        position: absolute;
        transform: translateY(-24px);
      }

      #gpa-button-container i.fa-question-circle:hover {
        cursor: pointer;
      }

      #gpa-button-container > button {
        background-color: #f3f4f6;
        color: #333;
        padding: 10px;
        border: 1px solid #ccc;
        border-radius: 5px;
        cursor: pointer;
        width: 100%;
        text-align: center;
      }

      #gpa-button-container > button:hover {
        background-color: #e2e3e5;
      }

      #eye-icon {
        position: absolute;
        top: 3px;
        right: 10px;
        cursor: pointer;
        font-size: 18px;
        color: #666;
      }

      #toggle-text {
        position: absolute;
        top: 8px;
        right: 36px;
        font-size: 12px;
        color: #666;
        cursor: pointer;
      }

      #gpa-semester-subcontainer select {
        width: fit-content;
        margin-bottom: 0;
        height: 2rem;
        font-size: 0.7rem;
      }
      
      #gpa-semester-subcontainer select:focus {
        outline: none !important;
      }

      #gpa-current-semester {
        position: absolute;
        top: 6px;
        left: 10px;
        color: #666;
        font-size: 12px;
        font-family: serif;   
      }

      #gpa-calculator-info-container {
        display: flex;
        flex-direction: row;
        align-items: center;
        gap: 0;
        margin-bottom: 6px;
        margin-left: -.5rem;
        height: 1.4rem;
      }

      #gpa-calculator-info {
        order: 1;
      }
        
      #gpa-calculator-info-text {
        min-width: fit-content;
        font-size: .5rem;
        text-align: left;
        display: none;
        margin-top: -10px;
        order: 1;
      }

      #gpa-calculator-info-label {
        font-size: .7rem;
        text-align: left;
        order: 2;
        margin-left: .3rem;
      }

      #gpa-calculator-info-container i.fa-question-circle:hover + div {
        display: revert;
      }

      #gpa-calculator-info-container div:has(+ i.fa-question-circle:hover) {
        display: none;
      }
    }
    `;
    document.head.appendChild(customStyling);
    // Create a template toggle switch element
    const toggleSwitch = document.createElement('div');
    toggleSwitch.classList.add('switch-container');
    const toggleSwitchLabel = document.createElement('label');
    toggleSwitchLabel.classList.add('switch');
    const toggleSwitchInput = document.createElement('input');
    toggleSwitchInput.type = 'checkbox';
    const toggleSwitchSlider = document.createElement('span');
    toggleSwitchSlider.classList.add('slider', 'round');
    toggleSwitchLabel.appendChild(toggleSwitchInput);
    toggleSwitchLabel.appendChild(toggleSwitchSlider);
    toggleSwitch.appendChild(toggleSwitchLabel);
    // Create elements for the GPA calculator
    const gpaCalculatorContainer = document.createElement('div');
    gpaCalculatorContainer.id = 'canvas-grades-pro-gpa-calculator';
    const gpaCurrentSemesterName = document.createElement('div');
    gpaCurrentSemesterName.id = 'gpa-current-semester';
    const gpaCalculatorToggleText = document.createElement('div');
    gpaCalculatorToggleText.id = 'toggle-text';
    gpaCalculatorToggleText.textContent = config.gpa_config?.gpa_view === false ? 'Show GPA' : 'Hide GPA';
    const gpaCalculatorToggleEye = document.createElement('div');
    gpaCalculatorToggleEye.id = 'eye-icon';
    const gpaCalculatorEyeIcon = document.createElement('i');
    gpaCalculatorEyeIcon.classList.add('fa', config.gpa_config?.gpa_view === false ? 'fa-eye-slash' : 'fa-eye');
    const gpaCumulativeTitle = document.createElement('div');
    gpaCumulativeTitle.classList.add('gpa-title');
    gpaCumulativeTitle.textContent = 'Cumulative GPA';
    const gpaCumulativeValue = document.createElement('div');
    gpaCumulativeValue.classList.add('gpa-value');
    const cumulativeCreditsValue = document.createElement('div');
    cumulativeCreditsValue.classList.add('credits-value');
    cumulativeCreditsValue.textContent = '-';
    if (config.gpa_config?.gpa_view === false) {
      gpaCumulativeValue.classList.add('blurred');
    }
    gpaCumulativeValue.textContent = '-';
    const gpaCumulativeSubContainer = document.createElement('div');
    gpaCumulativeSubContainer.id = 'gpa-cumulative-subcontainer';
    const gpaCumulativeSwitch = toggleSwitch.cloneNode(true);
    const gpaCumulativeCheckbox = gpaCumulativeSwitch.querySelector('input[type="checkbox"]');
    gpaCumulativeCheckbox.checked = config.gpa_config?.include_current_semester === true;
    const gpaCumulativeSubTitle = document.createElement('div');
    gpaCumulativeSubTitle.textContent = 'Include current term in cumulative GPA?'
    gpaCumulativeSubContainer.appendChild(gpaCumulativeSwitch);
    gpaCumulativeSubContainer.appendChild(gpaCumulativeSubTitle);
    const gpaCumulativeError = document.createElement('div');
    gpaCumulativeError.classList.add('gpa-error-message');
    // Create a subcontainer for the buttons
    const gpaCalculatorButtonContainer = document.createElement('div');
    gpaCalculatorButtonContainer.id = 'gpa-button-container';
    // Create tooltip for providing information about the different buttons
    const gpaCalculatorInfo = document.createElement('i');
    gpaCalculatorInfo.classList.add('fas', 'fa-question-circle');
    const gpaCalculatorInfoText = document.createElement('div');
    gpaCalculatorInfoText.id = 'gpa-calculator-info-text'
    gpaCalculatorInfoText.innerHTML = '<i><u>Edit GPA Config:</u></i> Set credits and grades for your courses<br><i><u>Edit GPA Standard:</u></i> Set letter grade to GPA mapping<br><i><u>Calculate Min Gpa:</u></i> Minimum GPA this term for target cumulative GPA';
    const gpaCalculatorInfoLabel = document.createElement('div');
    gpaCalculatorInfoLabel.id = 'gpa-calculator-info-label';
    gpaCalculatorInfoLabel.innerHTML = 'What are these buttons?';
    const gpaCalculatorInfoContainer = document.createElement('div');
    gpaCalculatorInfoContainer.id = 'gpa-calculator-info-container';
    gpaCalculatorInfoContainer.appendChild(gpaCalculatorInfo);
    gpaCalculatorInfoContainer.appendChild(gpaCalculatorInfoText);
    gpaCalculatorInfoContainer.appendChild(gpaCalculatorInfoLabel);
    gpaCalculatorInfo.insertAdjacentElement('afterend', gpaCalculatorInfoLabel);
    const gpaCalculatorEditConfig = document.createElement('button');
    gpaCalculatorEditConfig.id = 'edit-class-config';
    gpaCalculatorEditConfig.textContent = 'Edit GPA Config';
    const gpaCalculatorEditStandard = document.createElement('button');
    gpaCalculatorEditStandard.id = 'edit-gpa-standard';
    gpaCalculatorEditStandard.textContent = 'Edit GPA Standard';
    const gpaCalculatorMinGpa = document.createElement('button');
    gpaCalculatorMinGpa.id = 'calculate-min-gpa';
    gpaCalculatorMinGpa.textContent = 'Calculate Min GPA'
    // Create the container for the GPA titles and values
    const gpaCalculatorSubContainer = document.createElement('div');
    // Create the subcontainer for the semester and cumulative GPA's
    const gpaCumulativeContainer = document.createElement('div');
    gpaCumulativeContainer.appendChild(gpaCumulativeTitle);
    gpaCumulativeContainer.appendChild(gpaCumulativeValue);
    gpaCumulativeContainer.appendChild(cumulativeCreditsValue);
    gpaCumulativeContainer.appendChild(gpaCumulativeError);
    const gpaSemesterContainer = gpaCumulativeContainer.cloneNode(true);
    const gpaSemesterTitle = gpaSemesterContainer.firstElementChild;
    // Create a subcontainer for holding the semester dropdown/text 
    const gpaSemesterSubContainer = document.createElement('div');
    gpaSemesterSubContainer.id = 'gpa-semester-subcontainer';
    const gpaSemesterSubTitle = document.createElement('div');
    const gpaSemesterEditIcon = document.createElement('i');
    gpaSemesterEditIcon.classList.add('fas', 'fa-edit');
    gpaSemesterSubTitle.textContent = '';
    gpaSemesterSubContainer.appendChild(gpaSemesterEditIcon);
    gpaSemesterSubContainer.appendChild(gpaSemesterSubTitle);
    gpaCumulativeTitle.insertAdjacentElement('afterend', gpaCumulativeSubContainer);
    gpaSemesterTitle.insertAdjacentElement('afterend', gpaSemesterSubContainer);
    const gpaSemesterValue = gpaSemesterContainer.querySelector('.gpa-value');
    const semesterCreditsValue = gpaSemesterContainer.querySelector('.credits-value');
    semesterCreditsValue.textContent = '-';
    const gpaSemesterError = gpaSemesterContainer.lastElementChild;
    gpaSemesterTitle.textContent = 'Term GPA';
    gpaSemesterValue.textContent = '-';
    gpaCumulativeTitle.id = 'first-gpa-title';
    // Add all of the elements to the main GPA calculator container
    gpaCalculatorToggleEye.appendChild(gpaCalculatorEyeIcon);
    gpaCalculatorContainer.appendChild(gpaCurrentSemesterName);
    gpaCalculatorContainer.appendChild(gpaCalculatorToggleText);
    gpaCalculatorContainer.appendChild(gpaCalculatorToggleEye);
    gpaCalculatorSubContainer.appendChild(gpaCumulativeContainer);
    gpaCalculatorSubContainer.appendChild(gpaSemesterContainer);
    gpaCalculatorContainer.appendChild(gpaCalculatorSubContainer);
    gpaCalculatorInfoContainer.appendChild(gpaCalculatorInfo);
    gpaCalculatorInfoContainer.appendChild(gpaCalculatorInfoText);
    gpaCalculatorButtonContainer.appendChild(gpaCalculatorEditConfig);
    gpaCalculatorButtonContainer.appendChild(gpaCalculatorEditStandard);
    gpaCalculatorButtonContainer.appendChild(gpaCalculatorMinGpa);
    gpaCalculatorContainer.appendChild(gpaCalculatorInfoContainer);
    gpaCalculatorContainer.appendChild(gpaCalculatorButtonContainer);
    // Function for controlling the display of the GPA (normal display to blurred and vice versa)
    const toggleGPA = async function() {
      gpaCumulativeValue.classList.toggle('blurred');
      gpaSemesterValue.classList.toggle('blurred');
      const state = gpaCumulativeValue.classList.contains('blurred');
      gpaCalculatorToggleText.textContent = state ? 'Show GPA' : 'Hide GPA';
      gpaCalculatorEyeIcon.classList.add(state ? 'fa-eye-slash' : 'fa-eye');
      gpaCalculatorEyeIcon.classList.remove(state ? 'fa-eye' : 'fa-eye-slash');
      if (config.gpa_config === undefined) {
        config.gpa_config = {};
      }
      if (config.gpa === undefined) {
        config.gpa = {};
      }
      config.gpa_config.gpa_view = !state;
      await saveConfig(config.gpa_config, 'gpa_config');
    }
    // Attach event listeners
    gpaCalculatorToggleEye.addEventListener('click', toggleGPA);
    gpaCalculatorToggleText.addEventListener('click', toggleGPA);
    // Create card for your GPA (add it before all of the cards for your classes)
    const gpaCard = document.createElement('div');
    gpaCard.classList.add('ic-DashboardCard');
    // Hide the gpa card while it is being configured
    gpaCard.style.display = 'none';
    gpaCard.appendChild(gpaCalculatorContainer);
    // Get all of the courses that the user has taken (that they can view or at least know the existance of)
    // Loop through all of the pages until the page is empty (or until the world ends...)
    const allCourses = [];
    let coursesPage = 1;
    while (true) {
      const response = await fetch(`/api/v1/courses?per_page=100&include[]=term&state[]=unpublished&state[]=available&state[]=completed&state[]=deleted&enrollment_type=student&page=${coursesPage}`);
      const courses = await response.json();
      if (courses.length === 0) {
        break;
      }
      for (const course of courses) {
        if (course.access_restricted_by_date === true) {
          continue;
        }
        allCourses.push(course);
      }
      coursesPage++;
    }
    let gpaStandard = config.default_gpa_standard ?? default_gpa_standard;
    // Consider the user preference for adding the gpa card to the beginning or end of the dashboard card container
    if ((config.gpa_card?.position ?? 'first') === 'first') {
      document.querySelector('.ic-DashboardCard__box__container').prepend(gpaCard);
    } else {
      document.querySelector('.ic-DashboardCard__box__container').appendChild(gpaCard);
    }
    // Create popup for editing the configuration for the gpa calculator
    const popup = document.createElement('div');
    const overlay = document.createElement('div');
    const content = document.createElement('div');
    const closeButton = document.createElement('span');
    const popupTitle = document.createElement('h2');
    const popupNotes = document.createElement('p');
    const popupContainer = document.createElement('div');
    const saveChangesButton = document.createElement('button');
    const saveChangesLabel = document.createElement('p');
    const gpaGrid = document.createElement('div');
    const cols = ['Course Name', 'Term', 'Credits', 'Grade'];
    const badTermNames = ['Default Term', 'Catalog'];
    // Store data for each of the semesters (format: { term_id : [semester_name, semester_score, semester_credits, special_semester_credits] })
    window.semesters = {};
    // Store data for each of the special semesters (even if it's not new) (format: { term_name : [semester_score, semester_credits, special_semester_credits] })
    // Note that special semester credits are courses that have a NG (most likely transfer / AP credits)
    window.semesters_missing = {};
    // Store the id associated with a given semester (maps name to id)
    // If a name isn't in the lookup, then it's from the missing courses config (or at least this should be the case)
    window.semester_lookup = {};
    for (const col of cols) {
      const gridHeadItem = document.createElement('div');
      gridHeadItem.classList.add('grid-item', 'active');
      gridHeadItem.id = col.replace(/\s/g, '-').toLowerCase();
      gridHeadItem.textContent = col;
      gpaGrid.appendChild(gridHeadItem);
    }
    const gradeDropdown = document.createElement('select');
    // Temporarily add "auto" to gpa standard (so that it is included in the dropdown menu)
    gpaStandard['AUTO'] = Infinity;
    gpaStandard['blank'] = Infinity;
    const sortedGpaStandard = Object.keys(gpaStandard).sort((a,b) => {
      // If the GPA's associated with the two current letter grades are not equal, then compare them
      if (gpaStandard[a] !== gpaStandard[b]) {
        return gpaStandard[b] - gpaStandard[a];
      }
      // If they are equal, then compare the letter grade representations (while considering plus and minus signs)
      return (b + ',').localeCompare(a + ',');
    });
    for (const letterGrade of sortedGpaStandard) {
      const option = document.createElement('option');
      option.classList.add(letterGrade);
      option.textContent = letterGrade === 'blank' ? '' : letterGrade;
      option.value = gpaStandard[letterGrade];
      gradeDropdown.appendChild(option);
    }
    delete gpaStandard['AUTO'];
    delete gpaStandard['blank'];
    // Popuplate the gpa calculator menu with all of your courses (that you have taken or are currently taking)
    allCourses.sort((a,b) => {
      const a_term_id = a.term === undefined || badTermNames.includes(a.term.name) ? -Infinity : a.term.id;
      const b_term_id = b.term === undefined || badTermNames.includes(b.term.name) ? -Infinity : b.term.id;
      if (a_term_id != b_term_id) {
        return b_term_id - a_term_id;
      }
      return a.course_code === undefined ? 1 : (b.course_code === undefined ? -1 : a.course_code.localeCompare(b.course_code));
    });
    // Store the current semester id (get the maximum semester id)
    const currentSemesterId = window.maxActiveSemesterId;
    const currentSemesterName = window.maxActiveSemesterName;
    for (const course of allCourses) {
      if (course.term !== undefined && !badTermNames.includes(course.term.name) && window.semesters[course.term.id] === undefined) {
        window.semesters[course.term.id] = [course.term.name, 0, 0, 0];
      }
      if (course.term !== undefined && !badTermNames.includes(course.term.name) && window.semester_lookup[course.term.name] === undefined) {
        window.semester_lookup[course.term.name] = course.term.id;
      }
      for (const col of cols) {
        const gridItem = document.createElement('div');
        const name = col.replace(/\s/g, '-').toLowerCase();
        gridItem.classList.add('grid-item', `row-${course.id}`, name);
        if (name === 'course-name') {
          gridItem.textContent = course.course_code;
        } else if (name === 'term') {
          // Check if the term is valid
          if (course.term === undefined || badTermNames.includes(course.term.name)) {
            gridItem.textContent = '\u200b';
          } else {
            // gridItem.dataset.semester_id = course.term.id;
            gridItem.textContent = course.term.name;
          }
        } else if (name === 'credits') {
          const textInput = document.createElement('input');
          textInput.type = 'text';
          textInput.spellcheck = false;
          textInput.autocomplete = false;
          textInput.maxLength = 4;
          textInput.value = config.gpa?.[course.id]?.credits ?? '';
          gridItem.appendChild(textInput);
        } else if (name === 'grade') {
          const dropdown = gradeDropdown.cloneNode(true);
          // If the term for the current course is not the most recent / current term, then remove the "auto" option from the dropdown
          if (course.term === undefined || course.term.id !== currentSemesterId) {
            dropdown.querySelector('option[class="AUTO"]').remove();
          }
          gridItem.dataset.semester_id = course.term.id;
          gridItem.appendChild(dropdown);
        }
        gpaGrid.appendChild(gridItem);
      }
    }
    // Store info relating to the missing course
    config.gpa_missing ??= []; 
    for (const course of config.gpa_missing) {
      if (window.semesters_missing[course.term] === undefined) {
        window.semesters_missing[course.term] = [0, 0, 0];
      }
      // If the course does not have a grade, then treat it as special, or else, treat it as normal and contribute to semester score
      if (course.grade === 'NG') {
        window.semesters_missing[course.term][2] += Number(course.credits);
      } else {
        const courseGpa = gpaStandard[course.grade] ?? null;
        if (course.grade === '' || courseGpa === null) {
          window.gpaErrorMessage = `Grade is unknown for some courses. Check GPA config menu and "View / Configure Missing Courses" menu`;
          window.semesters_missing[course.term][0] = -1;
          continue;
        }
        window.semesters_missing[course.term][0] += Number(course.credits) * Number(courseGpa);
        window.semesters_missing[course.term][1] += Number(course.credits);
      }
    }
    gpaGrid.classList.add('grid-container');
    // Set the subtitle for the current semester (tells the user what the "current semester" is)
    gpaCurrentSemesterName.textContent = currentSemesterName === '' ? '' : `Current Term: ${currentSemesterName}`;
    gpaSemesterSubTitle.textContent = currentSemesterName || 'N/A';
    gpaSemesterSubTitle.style.fontSize = '.7rem';
    popupContainer.appendChild(gpaGrid);
    popup.classList.add('popup-canvas-grades-pro');
    overlay.classList.add('overlay');
    content.classList.add('content');
    closeButton.classList.add('close-btn');
    closeButton.innerHTML = '&times';
    popupTitle.textContent = 'GPA Course Config';
    popupNotes.innerHTML = `Note: For courses that are <span style="text-decoration:underline;">not (currently) graded</span> use 0 credits.<br><span style="font-size: 0.7rem;">Use "AUTO" grade to automatically calculate grades. Only for current term courses.</span><br><a id="missing-courses" style="font-size: 0.8rem;" href="javascript:void(0);">View / Configure Missing Courses</a>`;
    popupNotes.style.margin = '-5px 0 0';
    popupContainer.classList.add('container-canvas-grades-pro');
    saveChangesButton.id = 'popup-save-changes';
    saveChangesButton.textContent = 'Save Changes!';
    saveChangesLabel.id = 'popup-save-changes-label';
    saveChangesLabel.text = '\u200b';

    // Create semesters dropdown (will be cloned later rather than re-created)
    const semestersDropdown = document.createElement('select');
    for (const semesterID of Object.keys(window.semesters).sort((a,b) => +b - +a)) {
      const option = document.createElement('option');
      option.value = semesterID;
      option.textContent = window.semesters[semesterID][0];
      option.classList.add(`semester-${semesterID}`);
      semestersDropdown.appendChild(option);
    }
    // Add the missing courses to the semester dropdown
    for (const semesterName of Object.keys(window.semesters_missing)) {
      // Don't add the semester as it already exists (as a semester known by Canvas)
      if (window.semester_lookup[semesterName] !== undefined) {
        continue;
      }
      const option = document.createElement('option');
      option.value = `${semesterName}-special`;
      option.textContent = semesterName;
      option.classList.add(`semester-${semesterName.trim().replace(/\s/g, '-')}`, 'semester-special');
      semestersDropdown.appendChild(option);
    }
    content.appendChild(closeButton);
    content.appendChild(popupTitle);
    content.appendChild(popupNotes);
    content.appendChild(popupContainer);
    content.appendChild(saveChangesLabel);
    content.appendChild(saveChangesButton);
    popup.appendChild(overlay);
    popup.appendChild(content);
    // Copy the existing popup and modify it for the gpa standard configuration popup and the min gpa required for your current semester gpa calculator
    const gpaStandardPopup = popup.cloneNode(true);
    const minGpaPopup = popup.cloneNode(true);
    const missingCoursesPopup = popup.cloneNode(true);
    // Modify the cloned popups
    const gpaStandardContent = gpaStandardPopup.querySelector('.content');
    const minGpaContent = minGpaPopup.querySelector('.content');
    const missingCoursesContent = missingCoursesPopup.querySelector('.content');
    gpaStandardContent.replaceChildren();
    minGpaContent.replaceChildren();
    missingCoursesContent.replaceChildren();
    missingCoursesContent.style.height = 'fit-content';
    missingCoursesContent.style.overflowY = 'fit-content';
    // Configure the missing courses popup
    const gpaCalculatorMissingConfig = popupNotes.querySelector('#missing-courses');
    const missingCoursesTitle = popupTitle.cloneNode(true);
    missingCoursesTitle.textContent = 'GPA Missing Course Config';
    const missingCoursesGrid = gpaGrid.cloneNode(true);
    missingCoursesGrid.replaceChildren();    
    missingCoursesGrid.classList.add('special');
    const missingCoursesNotes = document.createElement('p');
    missingCoursesNotes.innerHTML = `Note: For AP / transfer credits, use <b>NG</b> for the <span style="text-decoration:underline;">grade</span>,<br><span style="font-size: 0.95rem;">and for the <span style="text-decoration:underline;">term name</span>, use <b>Transfer</b> (or any other name you prefer).</span><br><span style="font-size: 0.95rem;"></span></p>`;
    missingCoursesNotes.style.margin = '-5px 0 0';
    const missingSaveChangesButton = saveChangesButton.cloneNode(true);
    const missingSaveChangesLabel = saveChangesLabel.cloneNode(true);
    const addRowLine = document.createElement('div');
    const addRowContainer = document.createElement('span');
    const addRowText = document.createElement('span');
    const addRowButton = document.createElement('i');
    missingSaveChangesLabel.id = 'popup-missing-save-changes-label';
    missingSaveChangesLabel.text = '\u200b';
    addRowText.textContent = 'ADD ROW';
    addRowButton.classList.add('fas', 'fa-plus');
    addRowButton.style.margin = '6px';
    addRowContainer.appendChild(addRowButton);
    addRowContainer.appendChild(addRowText);
    addRowContainer.style.cursor = 'pointer';
    addRowContainer.style.backgroundColor = '#90ee90';
    addRowContainer.style.padding = '10px';
    addRowContainer.style.paddingRight = '15px';
    addRowContainer.style.borderRadius = '20px';
    addRowLine.style.margin = '20px 0';
    addRowLine.appendChild(addRowContainer);
    const missingCols = ['Course Name', 'Term', 'Credits', 'Grade', ''];
    for (const col of missingCols) {
      const gridHeadItem = document.createElement('div');
      gridHeadItem.classList.add('grid-item', 'active');
      if (col.length !== 0) {
        gridHeadItem.id = `special-${col.replace(/\s/g, '-').toLowerCase()}`;
      }
      gridHeadItem.textContent = col || '\u200b';
      missingCoursesGrid.appendChild(gridHeadItem);
    }
    // Function for removing a row
    const removeRow = function(trashCell) {
      // remove this and the previous 4 elements
      for (let i = 0; i < 4; i++) {
        trashCell.previousElementSibling.remove();
      }
      trashCell.remove();
    }
    // Function for adding a new empty row
    const addNewRow = function() {
      for (const col of missingCols) {
        const gridItem = document.createElement('div');
        const name = col.replace(/\s/g, '-').toLowerCase();
        gridItem.classList.add('grid-item', 'row-special');
        // Don't add empty string to classlist (will throw error)
        if (name.length !== 0) {
          gridItem.classList.add(name);
        }
        if (name === 'course-name' || name === 'term' || name === 'credits') {
          const textInput = document.createElement('input');
          textInput.type = 'text';
          textInput.spellcheck = false;
          textInput.autocomplete = false;
          textInput.style.textAlign = 'center';
          if (name === 'course-name') {
            textInput.style.width = '140px';
          } else if (name === 'term') {
            textInput.style.fontSize = '90%';
            textInput.style.width = '120px';
          } else if (name === 'credits') {
            textInput.maxLength = 4;
            textInput.style.width = '50px';
          }
          gridItem.appendChild(textInput);
        } else if (name === 'grade') {
          const dropdown = gradeDropdown.cloneNode(true);
          // Replace AUTO option with NG option (NG -> No Grade)
          const tmp = dropdown.querySelector('option[class="AUTO"]');
          tmp.classList.replace('AUTO', 'NG');
          tmp.textContent = 'NG';
          dropdown.style.width = '70px';
          // Re-append option to move it to the bottom
          tmp.remove();
          dropdown.appendChild(tmp);
          gridItem.appendChild(dropdown);
        } else if (name === '') {
          const trashIcon = document.createElement('i');
          trashIcon.classList.add('fas', 'fa-trash');
          trashIcon.style.height = '20px';
          trashIcon.style.margin = '10px 0';
          trashIcon.style.color = 'firebrick';
          trashIcon.style.cursor = 'pointer';
          trashIcon.addEventListener('click', () => removeRow(gridItem));
          gridItem.appendChild(trashIcon);
        }
        missingCoursesGrid.appendChild(gridItem);
      }
    }
    // Get all of the missing gpa courses (stored as an array of objects)
    for (const course of config.gpa_missing) {
      let pos = 0;
      for (const col of missingCols) {
        const gridItem = document.createElement('div');
        const name = col.replace(/\s/g, '-').toLowerCase();
        gridItem.classList.add('grid-item', 'row-special');
        // Don't add empty string to classlist (will throw error)
        if (name.length !== 0) {
          gridItem.classList.add(name);
        }
        if (name === 'course-name') {
          const textInput = document.createElement('input');
          textInput.type = 'text';
          textInput.spellcheck = false;
          textInput.autocomplete = false;
          textInput.style.textAlign = 'center';
          textInput.style.width = '140px';
          textInput.value = course.name;
          gridItem.appendChild(textInput);
        } else if (name === 'term') {
          const textInput = document.createElement('input');
          textInput.type = 'text';
          textInput.spellcheck = false;
          textInput.autocomplete = false;
          textInput.style.textAlign = 'center';
          textInput.style.fontSize = '90%';
          textInput.style.width = '120px';
          textInput.value = course.term;
          gridItem.appendChild(textInput);
        } else if (name === 'credits') {
          const textInput = document.createElement('input');
          textInput.type = 'text';
          textInput.maxLength = 4;
          textInput.spellcheck = false;
          textInput.autocomplete = false;
          textInput.style.textAlign = 'center';
          textInput.style.width = '50px';
          textInput.value = course.credits;
          gridItem.appendChild(textInput);
        } else if (name === 'grade') {
          const dropdown = gradeDropdown.cloneNode(true);          
          // Replace AUTO option with NG option (NG -> No Grade)
          const tmp = dropdown.querySelector('option[class="AUTO"]');
          tmp.classList.replace('AUTO', 'NG');
          tmp.textContent = 'NG';
          tmp.remove();
          dropdown.style.width = '70px';
          // Re-append option to move it to the bottom
          dropdown.appendChild(tmp);
          const storageOption = dropdown.querySelector(`option[class="${course.grade}"]`);
          if (storageOption !== null) {
            storageOption.selected = true;
          } else {
            dropdown.querySelector(`option[class="blank"]`).selected = true;
          }
          gridItem.appendChild(dropdown);
        } else if (name === '') {
          const trashIcon = document.createElement('i');
          trashIcon.classList.add('fas', 'fa-trash');
          trashIcon.style.height = '20px';
          trashIcon.style.margin = '10px 0';
          trashIcon.style.color = 'firebrick';
          trashIcon.style.cursor = 'pointer';
          trashIcon.addEventListener('click', () => removeRow(gridItem));
          gridItem.appendChild(trashIcon);
        }
        missingCoursesGrid.appendChild(gridItem);
      }
      pos++;
    }
    // If there are no rows, then add one empty row (so that the user isn't as confused)
    if (config.gpa_missing.length === 0) {
      addNewRow();
    }
    addRowContainer.addEventListener('click', addNewRow);
    const missingCoursesContainer = popupContainer.cloneNode();
    missingCoursesContainer.appendChild(missingCoursesGrid);
    // Add missing course elemenets to the popup
    missingCoursesContent.appendChild(missingCoursesTitle);
    missingCoursesContent.appendChild(missingCoursesNotes);
    missingCoursesContent.appendChild(missingCoursesContainer);
    missingCoursesContent.appendChild(addRowLine);
    missingCoursesContent.appendChild(missingSaveChangesLabel)
    missingCoursesContent.appendChild(missingSaveChangesButton);
    missingCoursesContent.appendChild(closeButton.cloneNode(true));
    // Configure event listener for saving configuration of the missing courses
    missingSaveChangesButton.addEventListener('click', async () => {
      // Note that if something in a row is empty, that is okay, as long as all cells in the row are empty
      // Get all of the cells in the grid container.
      const cells = Array.from(document.querySelectorAll('.container-canvas-grades-pro .grid-container.special > .grid-item:not(.active) > *'));
      if (cells.length % 5 !== 0) {
        throw new Error("Number of grid items should be divisible by 5.");
      }
      const tmp = {};
      const data = [];
      for (let i = 0; i < cells.length; i+=5) {
        const courseNameVal = cells[i].value.trim()
        const termVal = cells[i+1].value.trim();
        const creditsVal = cells[i+2].value.trim();
        const gradeVal = cells[i+3].options[cells[i+3].selectedIndex].textContent.trim();
        // If all entries are empty, then the row can be ignored since it contains no data
        if (courseNameVal === '' && termVal === '' && creditsVal === '' && gradeVal === '') {
          removeRow(cells[i+4].parentElement);
          continue;
        }
        // If at least one cell is empty and at least one cell is set, then present an error message
        if (courseNameVal === '' || termVal === '' || creditsVal === '' || gradeVal === '') {
          missingSaveChangesLabel.classList.add('error');
          missingSaveChangesLabel.textContent = 'Changes failed to save! Please complete all of the fields';
          return;
        }
        // Validate credits input
        if (!/^((\d+(\.(\d+)?)?)|(\.\d+))$/.test(creditsVal)) {  
          missingSaveChangesLabel.classList.add('error');
          missingSaveChangesLabel.textContent = 'Changes failed to save! Please use numerical values \u2265 0 for your credits';
          return;
        }
        // Check for duplicate course name
        if (window.courseNames.has(courseNameVal)) {
          missingSaveChangesLabel.classList.add('error');
          missingSaveChangesLabel.textContent = `Changes failed to save! Course name "${courseNameVal}" is already in use`;
          return;
        }
        // Check to see if the term name cannot be used
        if (badTermNames.includes(termVal)) {
          missingSaveChangesLabel.classList.add('error');
          missingSaveChangesLabel.textContent = `Changes failed to save! Term name "${termVal}" is a reserved keyword`;
          return;
        }
        data.push({
          name: courseNameVal,
          term: termVal,
          credits: Number(creditsVal),
          grade: gradeVal
        });
        if (tmp[termVal] === undefined) {
          tmp[termVal] = [0, 0, 0];
        }
        // If the course does not have a grade, then treat it as special, or else, treat it as normal and contribute to semester score
        if (gradeVal === 'NG') {
          tmp[termVal][2] += Number(creditsVal);
        } else {
          const courseGpa = gpaStandard[gradeVal] ?? null;
          if (gradeVal === '' || courseGpa === null) {
            window.gpaErrorMessage = `Grade is unknown for some courses. Check GPA config menu and "${gpaCalculatorMissingConfig.textContent}" menu`;
            window.semesters_missing[termVal][0] = -1;
            continue;
          }
          tmp[termVal][0] += Number(creditsVal) * Number(courseGpa);
          tmp[termVal][1] += Number(creditsVal);
        }
      }
      window.semesters_missing = tmp;
      // Get initially selected option
      const initialPos = !semestersDropdown.options[semestersDropdown.selectedIndex].classList.contains('semester-special') ? semestersDropdown.selectedIndex : -1;
      // Remove "old" missing semesters from the dropdown
      semestersDropdown.querySelectorAll('.semester-special').forEach(option => option.remove());
      // Add missing semesters to the dropdown
      for (const semesterName of Object.keys(window.semesters_missing)) {
        // Don't add the semester as it already exists (as a semester known by Canvas)
        if (window.semester_lookup[semesterName] !== undefined) {
          continue;
        }
        const option = document.createElement('option');
        option.value = `${semesterName}-special`;
        option.textContent = semesterName;
        option.classList.add(`semester-${semesterName.trim().replace(/\s/g, '-')}`, 'semester-special');
        semestersDropdown.appendChild(option);
      }
      window.semesterDropdownIndex = initialPos === -1 ? 0 : initialPos;
      semestersDropdown.selectedIndex = window.semesterDropdownIndex;
      window.semesterDropdownIndex = semestersDropdown.selectedIndex;
      window.semesterDropdownValue = semestersDropdown.options[semestersDropdown.selectedIndex].value;
      gpaSemesterSubTitle.textContent = semestersDropdown.options[semestersDropdown.selectedIndex].textContent;
      gpaSemesterEditIcon.classList.replace('fa-save', 'fa-edit');
      let selectedSemesterData = window.semesters[window.semesterDropdownValue];
      if (selectedSemesterData === undefined) {
        const semesterName = window.semesterDropdownValue.slice(0,-8);
        selectedSemesterData = window.semesters_missing[semesterName];
        gpaSemesterValue.textContent = selectedSemesterData[0] === -1 ? '⚠️' : (selectedSemesterData[1] === 0 ? 'N/A' : (Math.floor(1e3 * selectedSemesterData[0] / selectedSemesterData[1]) / 1e3).toFixed(3));
        semesterCreditsValue.textContent = selectedSemesterData[0] === -1 ? '' : (selectedSemesterData[1] + selectedSemesterData[2]) + ' Credits';
        gpaSemesterError.textContent = selectedSemesterData[0] === -1 ? `Credit count is unknown for some ${semesterName} courses` : '';
        return;
      }
      gpaSemesterValue.textContent = selectedSemesterData[1] === -1 ? '⚠️' : (selectedSemesterData[2] === 0 ? 'N/A' : (Math.floor(1e3 * selectedSemesterData[1] / selectedSemesterData[2]) / 1e3).toFixed(3));
      semesterCreditsValue.textContent = selectedSemesterData[1] === -1 ? '' : (selectedSemesterData[2] + selectedSemesterData[3]) + ' Credits';
      gpaSemesterError.textContent = selectedSemesterData[1] === -1 ? `Credit count is unknown for some ${selectedSemesterData[0]} courses` : '';

      // Processing was completed without finding any errors, so configure the label for a successful operation
      missingSaveChangesLabel.classList.remove('error');
      missingSaveChangesLabel.textContent = 'Changes saved successfully!';
      config.gpa_missing = data;
      await saveConfig(config.gpa_missing, 'gpa_missing');
      await calculateGpa(false);
      setTimeout(() => {
        missingSaveChangesLabel.textContent = '';
      }, 3000);
    });
    // Configure the gpa standard popup
    const gpaStandardTitle = popupTitle.cloneNode(true);
    gpaStandardTitle.textContent = 'GPA Standard Config';
    // Create and configure the table for the gpa standard (use config.default_gpa_standard)
    const gpaStandardTable = document.createElement('table');
    gpaStandardTable.id = 'gpa-standard-table';
    const gpaStandardHead = document.createElement('thead');
    const gpaStandardHeadRow = document.createElement('tr');
    for (const col of ['Grade', 'GPA']) {
      const cell = document.createElement('th');
      cell.scope = 'col';
      cell.textContent = col;
      gpaStandardHeadRow.appendChild(cell);
    }
    gpaStandardHead.appendChild(gpaStandardHeadRow);
    const gpaStandardBody = document.createElement('tbody');
    for (const letterGrade of sortedGpaStandard) {
      if (gpaStandard[letterGrade] === undefined) {
        continue;
      }
      const row = document.createElement('tr');
      const letterGradeCell = document.createElement('td');
      const gpaCell = document.createElement('td');
      letterGradeCell.textContent = letterGrade;
      gpaCell.textContent = gpaStandard[letterGrade];
      row.appendChild(letterGradeCell);
      row.appendChild(gpaCell);
      gpaStandardBody.appendChild(row);
    }
    gpaStandardTable.appendChild(gpaStandardHead);
    gpaStandardTable.appendChild(gpaStandardBody);
    const gpaStandardInputDesc = document.createElement('div');
    gpaStandardInputDesc.textContent = 'Please enter your GPA Standard below. Each line should be a letter grade and a gpa value, seperated by a space';
    const gpaStandardInput = document.createElement('textarea');
    gpaStandardInput.placeholder = 'A 4\nA- 3.7\nB+ 3.3\nB 3\nB- 2.7'
    gpaStandardInput.style.display = 'none';
    gpaStandardInput.id = 'gpa-standard-input';
    const gpaStandardInputMessage = document.createElement('div');
    gpaStandardInputMessage.id = 'gpa-standard-input-message';
    const gpaStandardButton = document.createElement('i');    
    gpaStandardButton.id = 'gpa-standard-button';
    gpaStandardButton.classList.add('fas', 'fa-edit');
    const gpaStandardButtonContainer = document.createElement('div');
    gpaStandardButtonContainer.id = 'gpa-standard-button-container';
    const gpaStandardButtonLabel = document.createElement('div');
    gpaStandardButtonLabel.textContent = 'Edit GPA Standard';
    // Add gpa standard elements to the popup
    gpaStandardContent.appendChild(gpaStandardTitle);
    gpaStandardContent.appendChild(gpaStandardInput);
    gpaStandardContent.appendChild(gpaStandardTable);
    gpaStandardButtonContainer.appendChild(gpaStandardButton);
    gpaStandardButtonContainer.appendChild(gpaStandardButtonLabel);
    gpaStandardContent.appendChild(gpaStandardInputMessage);
    gpaStandardContent.appendChild(gpaStandardButtonContainer); 
    gpaStandardContent.appendChild(closeButton.cloneNode(true));
    const editGpaStandard = async function() {
      // Modify the display of the gpa standard elements (show text input for editing and show table for viewing)
      if (gpaStandardButton.classList.contains('fa-edit')) { // Editing mode
        // Construct the default input text using the existing gpa standard
        let str = '';
        for (const row of Array.from(gpaStandardBody.children)) {
          str += `${row.firstElementChild.textContent} ${row.lastElementChild.textContent}\n`;
        }
        gpaStandardInput.value = str.trim();
        gpaStandardButton.classList.replace('fa-edit', 'fa-save');
        gpaStandardInput.style.display = '';
        gpaStandardTable.style.display = 'none';
        gpaStandardButtonLabel.textContent = 'Save GPA Standard';
      } else { // Saving mode
        // Valid the data and only save it to storage if the input is completely valid
        const input = gpaStandardInput.value.trim();
        if (input === '') {
          gpaStandardInputMessage.textContent = 'Please provide a non-empty input';
          return;
        }
        // Process each line and the data (only update in storage if everything is valid)
        const data = {};
        for (const line of input.split('\n')) {
          // If current line is empty, then skip
          if (line.trim().length === 0) {
            continue;
          }
          // If the current line is invalid, then set the error message and exit
          if (!/^.+\s+((\d+(\.(\d+)?)?)|(\.\d+))$/.test(line.trim())) {
            gpaStandardInputMessage.textContent = `Invalid input for "${line}"`;
            gpaStandardInputMessage.style.display = 'block';
            return;
          }
          // Line is valid, parse values then store
          const curr = line.trim().split(/\s+/);
          if (data[curr[0]] !== undefined) {
            gpaStandardInputMessage.textContent = `Please provide unique letter grades. "${curr[0]} was reused."`
          }
          data[curr[0]] = Number(curr[1]);
        }
        // Update the existing gpa standard in storage and in the existing local variable
        gpaStandard = data;
        config.default_gpa_standard = data;
        await saveConfig(config.default_gpa_standard, 'default_gpa_standard');
        gpaStandard['AUTO'] = Infinity;
        gpaStandard['blank'] = Infinity;
        const sortedGpaStandard = Object.keys(gpaStandard).sort((a,b) => {
          // If the GPA's associated with the two current letter grades are not equal, then compare them
          if (gpaStandard[a] !== gpaStandard[b]) {
            return gpaStandard[b] - gpaStandard[a];
          }
          // If they are equal, then compare the letter grade representations (while considering plus and minus signs)
          return (b + ',').localeCompare(a + ',');
        });
        // Reconstruct the dropdown and rebuild the gpa config table
        gpaStandardBody.replaceChildren();
        for (const grade of sortedGpaStandard) {
          if (gpaStandard[grade] === undefined || gpaStandard[grade] === Infinity) {
            continue;
          }
          const tableRow = document.createElement('tr');
          const gradeCell = document.createElement('td');
          const gpaCell = document.createElement('td');
          gradeCell.textContent = grade;
          gpaCell.textContent = gpaStandard[grade];
          tableRow.appendChild(gradeCell);
          tableRow.appendChild(gpaCell);
          gpaStandardBody.appendChild(tableRow);
        }
        // Update the master grade dropdown then re-clone to all of the existing dropdowns in the gpa config popup
        gradeDropdown.replaceChildren();
        for (const letterGrade of sortedGpaStandard) {
          const option = document.createElement('option');
          option.classList.add(letterGrade);
          option.textContent = letterGrade === 'blank' ? '' : letterGrade;
          option.value = gpaStandard[letterGrade] ?? Infinity;
          gradeDropdown.appendChild(option);
        }
        delete gpaStandard['AUTO'];
        delete gpaStandard['blank'];
        document.querySelectorAll('.container-canvas-grades-pro .grid-container:not(.special) > .grid-item > select').forEach(elm => {
          const dropdown = gradeDropdown.cloneNode(true);
          // Store the initial dropdown value, and set it for the newly created dropdown (if it's not in the newly created dropdown, use the blank option)
          const initial = elm.options[elm.selectedIndex].textContent || 'blank';
          if (+elm.parentElement.dataset.semester_id !== currentSemesterId) {
            dropdown.querySelector('option[class="AUTO"]').remove();
          }
          // Replace old dropdown menu with the newly rebuilt one based on the new gpa standard
          elm.replaceWith(dropdown);
          // Select the initial drop value for the newly cloned dropdown menu
          const initialOption = dropdown.querySelector(`option[class="${initial}"]`);
          if (initialOption !== null) {
            initialOption.selected = true;
            return;
          }
          const courseID = RegExp(/row-(\d+)/g).exec(dropdown.parentElement.classList.toString())[1];
          const storageOption = dropdown.querySelector(`option[class="${config.gpa?.[courseID].letter_grade}"]`);
          if (storageOption !== null) {
            storageOption.selected = true;
            return;
          }
          // Make sure to initialize the nested config.gpa object if it is not defined (using nullish coalescing assignment aka ??=)
          // Also make sure not to reset the letter grade (if you do, then the grade will reset without the user knowing -- happens if user removes a configured letter grade that they are using)
          config.gpa ??= {};
          config.gpa[courseID] ??= {};
          dropdown.querySelector(`option[class="blank"]`).selected = true;
        });
        document.querySelectorAll('.container-canvas-grades-pro .grid-container.special > .grid-item > select').forEach(elm => {
          const dropdown = gradeDropdown.cloneNode(true);
          // Replace AUTO option with NG option (NG -> No Grade)
          const tmp = dropdown.querySelector('option[class="AUTO"]');
          tmp.classList.replace('AUTO', 'NG');
          tmp.textContent = 'NG';
          dropdown.style.width = '70px';
          // Re-append option to move it to the bottom
          tmp.remove();
          dropdown.appendChild(tmp);
          // Replace old dropdown menu with the newly rebuilt one based on the new gpa standard
          elm.replaceWith(dropdown);
          const targetCourseName = dropdown.parentElement.previousElementSibling.previousElementSibling.previousElementSibling.firstElementChild.value.trim();
          const courseGrade = config.gpa_missing?.find(course => course?.name === targetCourseName)?.grade?.trim() ?? null;
          const storageOption = dropdown.querySelector(`option[class="${courseGrade}"]`);
          if (courseGrade !== null && storageOption !== null) {
            storageOption.selected = true;
            return;
          }
          config.gpa_missing ??= {};
          dropdown.querySelector(`option[class="blank"]`).selected = true;
        });
        gpaStandardInputMessage.textContent = '';
        gpaStandardInputMessage.style.display = '';
        gpaStandardButton.classList.replace('fa-save', 'fa-edit');
        gpaStandardInput.style.display = 'none';
        gpaStandardTable.style.display = '';
        gpaStandardButtonLabel.textContent = 'Edit GPA Standard';
        // Run the appropriate operations to re-calculate the gpa (save the gpa config then re-calculate it)
        await saveConfig(config.gpa, 'gpa');
        await calculateGpa(false);
      }
    }
    gpaStandardButton.addEventListener('click', editGpaStandard);
    gpaStandardButtonLabel.addEventListener('click', editGpaStandard);
    // Configure the min gpa popup
    const minGpaContainer = document.createElement('div');
    const minGpaTitle = popupTitle.cloneNode(true);  
    minGpaTitle.textContent = 'Min GPA Calculator';
    const minGpaLeftSubtitle = document.createElement('h5');
    minGpaLeftSubtitle.textContent = 'Desired GPA';
    const minGpaRightSubtitle = document.createElement('h5');
    minGpaRightSubtitle.textContent = 'Minimum GPA Required';
    const minGpaInput = document.createElement('input'); 
    minGpaInput.textContent = 'Find min GPA required for the current semester to get your desired GPA';
    const minGpaRequired = document.createElement('span');
    minGpaRequired.textContent = '\u200b';
    minGpaContainer.id = 'min-gpa-container';
    const minGpaLeftSubContainer = document.createElement('div');
    const minGpaRightSubContainer = document.createElement('div');
    const minGpaMessage = document.createElement('div');
    minGpaMessage.id = 'min-gpa-message';
    minGpaMessage.textContent = '\u200b';
    const minGpaCalculateBtn = document.createElement('button');
    minGpaCalculateBtn.id = 'min-gpa-calculate-btn';
    minGpaCalculateBtn.textContent = 'Calculate!';
    // Add gpa standard elements to the popup
    minGpaContent.appendChild(minGpaTitle);
    minGpaLeftSubContainer.appendChild(minGpaLeftSubtitle);
    minGpaLeftSubContainer.appendChild(minGpaInput);
    minGpaRightSubContainer.appendChild(minGpaRightSubtitle);
    minGpaRightSubContainer.appendChild(minGpaRequired);
    minGpaContainer.appendChild(minGpaLeftSubContainer);
    minGpaContainer.appendChild(minGpaRightSubContainer);
    minGpaContent.appendChild(minGpaContainer);
    minGpaContent.appendChild(minGpaMessage);
    minGpaContent.appendChild(minGpaCalculateBtn);
    minGpaContent.appendChild(closeButton.cloneNode(true));
    const findMinGpaRequired = function() {
      const desiredGpa = minGpaLeftSubContainer.querySelector('input').value;
      if (!/^((\d+(\.(\d+)?)?)|(\.\d+))$/.test(desiredGpa.trim())) {
        minGpaMessage.textContent = "Please use non-negative numerical values for your desired GPA";
        minGpaRequired.textContent = '';
        const oldTableContainer = minGpaContent.querySelector('#min-gpa-table-container');
        if (oldTableContainer !== null) {
          oldTableContainer.replaceChildren();
        }
        return;
      }
      minGpaMessage.textContent = '\u200b';
      const data = Object.values(window.semesters);
      let qualityPoints = -window.semesters[currentSemesterId][1];
      let credits = 0;
      for (const termData of data) {
        if (termData[1] === -1) {
          minGpaMessage.textContent = "Please use non-negative numerical values for your desired GPA";
          minGpaRequired.textContent = '';
          const oldTableContainer = minGpaContent.querySelector('#min-gpa-table-container');
          if (oldTableContainer !== null) {
            oldTableContainer.replaceChildren();
          }
          return;
        }
        qualityPoints += termData[1];
        credits += termData[2];
      }
      if (credits === 0) {
        const oldTableContainer = minGpaContent.querySelector('#min-gpa-table-container');
        if (oldTableContainer !== null) {
          oldTableContainer.replaceChildren();
        }
        console.error('Zero credits were detected for the current term', window.semesters);
      }
      const minGpa = Math.max(0, Math.floor(1e3 * ((+desiredGpa * credits - qualityPoints) / window.semesters[currentSemesterId][2])) / 1e3);
      const gpaStandardGrades = Object.keys(gpaStandard);
      let maxLetterGrade = gpaStandardGrades[0];
      for (const letterGrade of gpaStandardGrades) {
        // If the GPA's associated with the two current letter grades are not equal, then compare them
        if (gpaStandard[letterGrade] !== gpaStandard[maxLetterGrade]) {
          maxLetterGrade = gpaStandard[letterGrade] > gpaStandard[maxLetterGrade] ? letterGrade : maxLetterGrade;
          continue;
        }
        // If they are equal, then compare the letter grade representations (while considering plus and minus signs)
        maxLetterGrade = (maxLetterGrade + ',').localeCompare(letterGrade + ',') > 1 ? maxLetterGrade : letterGrade;
      }
      minGpaRequired.textContent = Number(minGpa.toFixed(3)) + (gpaStandard[maxLetterGrade] < minGpa ? ' 😭' : (minGpa === 0 ? ' 🗿' : ''));
      // If the user cannot get their desired gpa or if they don't have to do anything to get it, then exit early
      if (gpaStandard[maxLetterGrade] < minGpa || minGpa === 0) {
        const oldTable = document.getElementById('min-gpa-table');
        if (oldTable !== null) {
          oldTable.parentElement.replaceChildren();
        }
        return;
      }
      // If the current term credits includes an invalid credit, then throw an error since this point should not have been reached
      if (window.currentTermCredits.includes(-1)) {
        console.error('An error occurred when finding the minimum GPA combinations', window.currentTermCredits);
      }
      // If the user needs to "try" in order to get their desired gpa, they can use any of the generated combinations from getMinGpaCombinations()
      window.currentTermCredits = window.currentTermCredits.filter(credits => credits !== 0);
      // Add all of the missing courses from the current term (technically wouldn't make sense for there to be any)
      const missingCourseCredits = [];
      for (const course of config.gpa_missing) {
        if (course.term !== currentSemesterName || course.grade === 'NG') {
          continue;
        }
        missingCourseCredits.push(Number(course.credits));
      }
      const totalCurrentTermCredits = window.currentTermCredits.concat(missingCourseCredits);
      const gradesData = getMinGpaCombinations(gpaStandard, totalCurrentTermCredits, minGpa);
      // If there is no data, do not generate a table (this should not happen)
      if (gradesData.length === 0) {
        console.error('Zero rows of data were generated for your required min gpa', totalCurrentTermCredits);
        return;
      }
      const uniqueCourseCredits = [...new Set(totalCurrentTermCredits)].sort((a,b) => b-a);
      const minGpaTable = document.createElement('table');
      minGpaTable.id = 'min-gpa-table';
      // Create and configure the main column (credits)
      const minGpaTableRow = document.createElement('tr');
      const minGpaTableCredits = document.createElement('th');
      minGpaTableCredits.colSpan = totalCurrentTermCredits.length;
      minGpaTableCredits.textContent = 'Credits';
      minGpaTableRow.appendChild(minGpaTableCredits);
      minGpaTable.appendChild(minGpaTableRow);
      // Create and configure the subcolumns (each credit count that you currently have)
      const creditsRow = document.createElement('tr');
      // const credits of uniqueCourseCredits
      for (let i = 0; i < uniqueCourseCredits.length; i++) {
        const credits = uniqueCourseCredits[i];
        const creditsCell = document.createElement('td');
        creditsCell.textContent = credits;
        creditsCell.colSpan = gradesData[0][credits].length;
        // If this is not the last group, then add a border
        if (i !== uniqueCourseCredits.length-1) {
          creditsCell.classList.add('cell-divider');
        }
        creditsRow.appendChild(creditsCell);
      }
      minGpaTable.appendChild(creditsRow);
      for (const result of gradesData) {
        const row = document.createElement('tr');
        for (let i = 0; i < uniqueCourseCredits.length; i++) {
          const credits = uniqueCourseCredits[i];
          for (let j = 0; j < result[credits].length; j++) {
            const grade = result[credits][j];
            const gradesCell = document.createElement('td');
            gradesCell.textContent = grade;
            if (i !== uniqueCourseCredits.length-1 && j === result[credits].length-1) {
              gradesCell.classList.add('cell-divider');
            }
            if (i !== uniqueCourseCredits.length-1 && j !== result[credits].length-1) {
              gradesCell.classList.add('cell-subdivider');
            }
            row.appendChild(gradesCell);
          }
        }
        minGpaTable.appendChild(row);
      }
      // If there is an old table, then replace it with the new table
      const oldTableContainer = minGpaContent.querySelector('#min-gpa-table-container');
      const tableDesc = document.createElement('h5');
      tableDesc.textContent = 'Grade Combinations for Achieving Minimum GPA';
      if (oldTableContainer !== null) {
        oldTableContainer.replaceChildren();
        oldTableContainer.appendChild(tableDesc);
        oldTableContainer.appendChild(minGpaTable);
      } else {
        const minGpaTableContainer = document.createElement('div');
        minGpaTableContainer.id = 'min-gpa-table-container';
        minGpaTableContainer.appendChild(tableDesc);
        minGpaTableContainer.appendChild(minGpaTable);
        minGpaContent.appendChild(minGpaTableContainer);
      }
    }
    minGpaCalculateBtn.addEventListener('click', findMinGpaRequired);
    minGpaInput.addEventListener('keydown', event => {
      if (event.key === 'Enter') {
        findMinGpaRequired();
      }
    });
    document.body.appendChild(popup);
    document.body.appendChild(gpaStandardPopup);
    document.body.appendChild(minGpaPopup);
    document.body.appendChild(missingCoursesPopup); 
    gpaCumulativeCheckbox.addEventListener('change', async () => {
      // Switch between the two different grades that are computed (grade with current semester and grade without current semester)
      gpaCumulativeValue.textContent = window.currentSemesterGpa[gpaCumulativeCheckbox.checked ? 0 : 1];
      const tmp = window.currentCredits[gpaCumulativeCheckbox.checked ? 0 : 1];
      cumulativeCreditsValue.textContent = tmp === '' ? '' : `${tmp} Credits`;
      if (config.gpa === undefined) {
        config.gpa = {};
      }
      if (config.gpa_config === undefined) {
        config.gpa_config = {};
      }
      config.gpa_config.include_current_semester = gpaCumulativeCheckbox.checked;
      await saveConfig(config.gpa_config, 'gpa_config');
    });
    // Set the initial index for the semesters dropdown (this shouldn't fail since the "current semester" has to exist to be the current semester)
    semestersDropdown.querySelector(`option[class="semester-${currentSemesterId}"]`).selected = true;
    window.semesterDropdownIndex = semestersDropdown.selectedIndex;
    // Add event listeners for controlling different elements relating to the gpa calculator popup
    gpaSemesterEditIcon.addEventListener('click', () => {
      // Check if we are saving or editing
      if (gpaSemesterEditIcon.classList.contains('fa-save')) { // Saving mode
        const dropdown = gpaSemesterEditIcon.nextElementSibling.firstElementChild;
        window.semesterDropdownIndex = dropdown.selectedIndex;
        window.semesterDropdownValue = dropdown.options[dropdown.selectedIndex].value;
        dropdown.parentElement.textContent = dropdown.options[dropdown.selectedIndex].textContent;
        gpaSemesterEditIcon.classList.replace('fa-save', 'fa-edit');
        let selectedSemesterData = window.semesters[window.semesterDropdownValue];
        if (selectedSemesterData === undefined) {
          const semesterName = window.semesterDropdownValue.slice(0,-8);
          selectedSemesterData = window.semesters_missing[semesterName];
          gpaSemesterValue.textContent = selectedSemesterData[0] === -1 ? '⚠️' : (selectedSemesterData[1] === 0 ? 'N/A' : (Math.floor(1e3 * selectedSemesterData[0] / selectedSemesterData[1]) / 1e3).toFixed(3));
          semesterCreditsValue.textContent = selectedSemesterData[0] === -1 ? '' : (selectedSemesterData[1] + selectedSemesterData[2]) + ' Credits';
          gpaSemesterError.textContent = selectedSemesterData[0] === -1 ? `Credit count is unknown for some ${semesterName} courses` : '';
          return;
        }
        gpaSemesterValue.textContent = selectedSemesterData[1] === -1 ? '⚠️' : (selectedSemesterData[2] === 0 ? 'N/A' : (Math.floor(1e3 * selectedSemesterData[1] / selectedSemesterData[2]) / 1e3).toFixed(3));
        semesterCreditsValue.textContent = selectedSemesterData[1] === -1 ? '' : (selectedSemesterData[2] + selectedSemesterData[3]) + ' Credits';
        gpaSemesterError.textContent = selectedSemesterData[1] === -1 ? `Credit count is unknown for some ${selectedSemesterData[0]} courses` : '';
      } else { // Editing mode
        const dropdown = semestersDropdown.cloneNode(true);
        dropdown.selectedIndex = window.semesterDropdownIndex;
        gpaSemesterEditIcon.nextElementSibling.replaceChildren(dropdown);
        gpaSemesterEditIcon.classList.replace('fa-edit', 'fa-save');
      }
    });
    // Modify this event listener for the class grades/credits config so that the dropdowns are all recloned (loop through them, and replace the children of the parent element with the newly created dropdown; dropdown needs to be changed during save)
    gpaCalculatorEditConfig.addEventListener('click', () => {
      gpaStandardPopup.classList.remove('active');
      minGpaPopup.classList.remove('active');
      missingCoursesPopup.classList.remove('active');
      popup.classList.add('active');
    });
    gpaCalculatorEditStandard.addEventListener('click', () => {
      popup.classList.remove('active');
      minGpaPopup.classList.remove('active');
      missingCoursesPopup.classList.remove('active');
      gpaStandardPopup.classList.add('active');
    });
    gpaCalculatorMinGpa.addEventListener('click', () => {
      popup.classList.remove('active');
      gpaStandardPopup.classList.remove('active');
      missingCoursesPopup.classList.remove('active');
      minGpaPopup.classList.add('active');
    });
    gpaCalculatorMissingConfig.addEventListener('click', () => {
      popup.classList.remove('active');
      gpaStandardPopup.classList.remove('active');
      minGpaPopup.classList.remove('active');
      missingCoursesPopup.classList.add('active');
    });
    document.querySelectorAll('.close-btn').forEach(elm => {
      elm.addEventListener('click', () => {
        popup.classList.remove('active');
        gpaStandardPopup.classList.remove('active');
        minGpaPopup.classList.remove('active');
        missingCoursesPopup.classList.remove('active');
      });
    });
    window.addEventListener('keydown', event => {
      if (event.key === 'Escape') {
        popup.classList.remove('active');
        gpaStandardPopup.classList.remove('active');
        minGpaPopup.classList.remove('active');
        missingCoursesPopup.classList.remove('active');
      } 
    });
    saveChangesButton.addEventListener('click', async () => {
      // Store the values for your semester class credits and gpa scores "temporarily" (this object will replace the object at window.semesters if the input is good)
      const tmp = {};
      const gpaData = {};
      for (const course of allCourses) {
        const courseID = course.id;
        const credits = document.querySelector(`.row-${courseID}.credits > input`).value.trim();
        const select = document.querySelector(`.row-${courseID}.grade > select`);
        const letterGrade = select.options[select.selectedIndex].textContent;
        const courseGpa = gpaStandard[letterGrade] ?? null;
        // Check if the data that was inputted is "bad"
        if (!/^((\d+(\.(\d+)?)?)|(\.\d+))$/.test(credits)) {  
          saveChangesLabel.classList.add('error');
          saveChangesLabel.textContent = 'Changes failed to save! Please use numerical values \u2265 0 for your credits';
          return;
        }
        if (Number(credits) !== 0 && letterGrade !== 'AUTO' && (letterGrade === '' || courseGpa === null)) {
          saveChangesLabel.classList.add('error');
          saveChangesLabel.textContent = 'Changes failed to save! Please provide a grade for all of your courses';
          return;
        }
        if (course.term !== undefined && !badTermNames.includes(course.term.name)) {
          if (tmp[course.term.id] === undefined) {
            tmp[course.term.id] = [course.term.name, 0, 0, 0];
          }
          tmp[course.term.id][1] += Number(credits);
          tmp[course.term.id][2] += Number(credits) * Number(courseGpa);
        }
        gpaData[courseID] = { credits, letter_grade: letterGrade };
      }
      // Processing was completed without finding any errors, so configure the label for a successful operation
      saveChangesLabel.classList.remove('error');
      saveChangesLabel.textContent = 'Changes saved successfully!';
      window.semesters = tmp;
      config.gpa = gpaData;
      await saveConfig(gpaData, 'gpa');
      await calculateGpa(false);
      setTimeout(() => {
        saveChangesLabel.textContent = '';
      }, 3000);
    });
    // Calculate the GPA for the student
    const calculateGpa = async function(initialCall = false) {
      let creditTotal = 0;
      let missingCreditTotal = 0;
      let gpaTotal = 0;
      window.semesters = {};
      window.currentTermCredits = [];
      window.gpaErrorMessage = '';
      window.gpaBadCourses = new Set();
      // Get the max letter grade (grade associated with the highest gpa) for usage with courses that have no grade
      const gpaStandardGrades = Object.keys(gpaStandard);
      let maxLetterGrade = gpaStandardGrades[0];
      for (const letterGrade of gpaStandardGrades) {
        // If the GPA's associated with the two current letter grades are not equal, then compare them
        if (gpaStandard[letterGrade] !== gpaStandard[maxLetterGrade]) {
          maxLetterGrade = gpaStandard[letterGrade] > gpaStandard[maxLetterGrade] ? letterGrade : maxLetterGrade;
          continue;
        }
        // If they are equal, then compare the letter grade representations (while considering plus and minus signs)
        maxLetterGrade = (maxLetterGrade + ',').localeCompare(letterGrade + ',') > 1 ? maxLetterGrade : letterGrade;
      }
      window.courseNames = new Set();
      for await (const course of allCourses) {
        // Configure the semesters object (to store gpa data on each semester)
        if (course.term !== undefined && !badTermNames.includes(course.term.name) && window.semesters[course.term.id] === undefined) {
          window.semesters[course.term.id] = [course.term.name, 0, 0, 0];
        }
        const courseConfig = config[course.id] ?? {};
        const classGradingStandard = course.grading_standard_id !== null && course.grading_standard_id !== undefined ? (await retrieveGradingStandard(course.id, course.grading_standard_id)) : null;
        if (course.term?.id === currentSemesterId) {
          window.currentTermCredits.push(Number(config.gpa?.[course.id]?.credits ?? -1));
        }
        // Store flag for detecting if the current course is using "AUTO" and is a current term course
        let autoFlag = false;
        // Use a IIFE to compute the letter grade for a given course if the grade is in computed grades "cache" or in chrome storage
        const letterGrade = (function() {
          // Implementation may be subjectively desired -- if a new term is introduced before the current term ends (e.g. from registering for your courses for the next term)
          // then the "old" current term should still have grades calculated via the dashboard grade, which should be used for the gpa calculation.
          // However, doing so would cause valid grades to be overriden from your history when the semester ends, so I will not being doing this for now
          // Current approach to this is retrieving the current term using the maximum course term id from the dashboard course cards 
          const tmp = config.gpa?.[course.id]?.letter_grade ?? '';
          if ((tmp === 'AUTO' || tmp === '') && course.term?.id === currentSemesterId) {
            autoFlag = true;
            return null;
          }
          // If this executes, this means that grade is bad "AUTO" (not a course in the current term)
          if (tmp === 'AUTO') {
            return null;
          }
          // In the final base case, tmp is either '' (blank) or set
          return tmp === '' ? null : tmp;
        })() ?? await (async function() {
          const grade = window.computedGrades[course.id.toString()]?.[0] ?? (await getCourseGrade(course, courseConfig, null, null, false))[0];
          if (grade === 'NG' && !autoFlag) {
            return null; 
          }
          const tmpLetterGrade = await getLetterGrade(courseConfig.grading_standard ?? classGradingStandard ?? config.default_grading_standard ?? default_grading_standard, grade) ?? null;
          // If there is no calculated grade but the grade is set to "AUTO", then use the max grade available. 
          // If the letter grade could not be computed, use null, or else just use the computed letter grade
          return tmpLetterGrade === null ? maxLetterGrade : (tmpLetterGrade === 'N/A' ? null : tmpLetterGrade);
        })() ?? '';
        const courseGpa = gpaStandard[letterGrade] ?? null;
        const credits = config.gpa?.[course.id]?.credits ?? null;
        window.courseNames.add(course.course_code.trim());
        // On the initial case (for page load, replace any blank grades and any invalid "AUTO" grades with the manually calculated grade)
        if (initialCall && !autoFlag) {
          // Make sure to initialize the nested config.gpa object if it is not defined (using nullish coalescing assignment aka ??=)
          config.gpa ??= {};
          config.gpa[course.id] ??= {};
          config.gpa[course.id].letter_grade = letterGrade ?? '';
        } 
        // Missing grade when using AUTO flag
        if (course.term !== undefined && Number(credits) !== 0 && courseGpa === null && autoFlag) {
          // Add missing grades to the set (used for informing the user of missing letter grades)
          window.gpaBadCourses.add(letterGrade);
          window.semesters[course.term.id][1] = -1;
          continue;
        }
        // Missing grade for when the letter grade is set (explicit, not AUTO)
        if (course.term !== undefined && Number(credits) !== 0 && letterGrade !== 'NG' && (letterGrade === '' || courseGpa === null)) {
          window.gpaErrorMessage = 'Grade is unknown for some courses';
          // If the course is a valid course, then mark the semester for the course as invalid for grades
          window.semesters[course.term.id][1] = -1;
          continue;
        }
        document.querySelector(`.row-${course.id} option[class="${autoFlag ? 'AUTO' : (letterGrade === '' || courseGpa === null ? 'blank' : letterGrade)}"]`).selected = true;
        // If the course is an valid course with credits that haven't been set, then mark the semester for the course as invalid and set the error message
        if (course.term !== undefined && credits === null && window.semesters[course.term.id] !== undefined) {
          window.gpaErrorMessage = 'Credit count is unknown for some courses';
          window.semesters[course.term.id][1] = -1;
          continue;
        }
        creditTotal += Number(credits);
        gpaTotal += Number(courseGpa) * Number(credits);
        if (course.term !== undefined && (window.semesters[course.term.id] ?? [-1,-1])[1] !== -1) {
          window.semesters[course.term.id][1] += Number(courseGpa) * Number(credits);
          window.semesters[course.term.id][2] += Number(credits);
        }
      }
      for (const course of config.gpa_missing) {
        if (window.courseNames.has(course.name)) {
          window.gpaErrorMessage = `Course name "${course.name}" is already in use. Fix in "${gpaCalculatorMissingConfig.textContent}" menu`;
          window.semesters_missing[course.term][0] = -1;
        }
        const semesterID = window.semester_lookup[course.term];
        // If this is not an existing semester (established via Canvas), then nothing more to do 
        if (semesterID === undefined) {
          missingCreditTotal += Number(course.credits);
          continue;
        }
        const courseGpa = gpaStandard[course.grade] ?? null;
        if (course.grade === '' || (course.grade !== 'NG' && courseGpa === null)) {
          window.gpaErrorMessage = `Grade is unknown for some courses. Check GPA config menu and "${gpaCalculatorMissingConfig.textContent}" menu`;
          window.semesters_missing[course.term][0] = -1;
          continue;
        }
        // If the course is not graded, then treat it as special, or else treat it as normal 
        if (course.grade === 'NG') {
          window.semesters[semesterID][3] += Number(course.credits);
          missingCreditTotal += Number(course.credits);
        } else {
          window.semesters[semesterID][1] += Number(course.credits) * Number(courseGpa);
          window.semesters[semesterID][2] += Number(course.credits);
          gpaTotal += Number(course.credits) * Number(courseGpa);
          creditTotal += Number(course.credits);
        }
      }
      // For this, we will be truncating at two decimal places (UMD uses 3 decimal truncation)
      const cumulativeGpa = (Math.floor(1e3 * gpaTotal / creditTotal) / 1e3).toFixed(3);
      // Get the gpa for the term selected in the current term dropdown
      const selectedSemesterData = window.semesters[window.semesterDropdownValue ?? currentSemesterId];
      // Calculate the gpa without the current/most recent semester (if the student has no courses prior to the current semester, then display N/A)
      const cumulativeGpaAlt = (creditTotal - window.semesters[currentSemesterId][2]) === 0 ? 'N/A' : (Math.floor(1e3 * (gpaTotal - window.semesters[currentSemesterId][1]) / (creditTotal - window.semesters[currentSemesterId][2])) / 1e3).toFixed(3);
      const badGpaFlag = isNaN(cumulativeGpa) || window.gpaErrorMessage !== '';
      // Store the cumulative gpa with the current semester and without the current semester
      window.currentSemesterGpa = badGpaFlag ? ['⚠️','⚠️'] : [cumulativeGpa, cumulativeGpaAlt] // [gpa WITH current sem, gpa WITHOUT current sem]
      window.currentCredits = badGpaFlag ? ['',''] : [creditTotal + missingCreditTotal, creditTotal - window.semesters[currentSemesterId][2] + missingCreditTotal]; // [credits WITH current sem, credits WITHOUT current sem]
      gpaCumulativeValue.textContent = badGpaFlag ? '⚠️' : window.currentSemesterGpa[gpaCumulativeCheckbox.checked ? 0 : 1];
      cumulativeCreditsValue.textContent = badGpaFlag ? '' : window.currentCredits[gpaCumulativeCheckbox.checked ? 0 : 1] + ' Credits';
      gpaCalculatorEditConfig.textContent = badGpaFlag ? 'Edit GPA Config ⚠️' : 'Edit GPA Config';
      gpaCumulativeError.textContent = window.gpaErrorMessage;
      gpaSemesterValue.textContent = selectedSemesterData[1] === -1 ? '⚠️' : (selectedSemesterData[2] === 0 ? 'N/A' : (Math.floor(1e3 * selectedSemesterData[1] / selectedSemesterData[2]) / 1e3).toFixed(3));
      semesterCreditsValue.textContent = selectedSemesterData[1] === -1 ? '' : (selectedSemesterData[2] + selectedSemesterData[3]) + ' Credits';
      gpaSemesterError.textContent = selectedSemesterData[1] === -1 ? `${window.gpaErrorMessage.startsWith('Grade') ? 'Grade' : 'Credit count'} is unknown for some "${selectedSemesterData[0]}" courses` : '';
      // If there are grades that are missing from the gpa mapping, then check the following conditions:
      // If the selected semester is the current term OR if the cumulative GPA is including the current term, then reveal the missing grades in an error message (override any other existing error message)
      if (window.gpaBadCourses.size !== 0) {
        // Check if the error message should display for the term gpa
        if (selectedSemesterData[0] === currentSemesterName) {
          gpaSemesterError.textContent = `GPA standard is missing the following grades: ${[...window.gpaBadCourses].join(', ')}`;
        }
        // Check if the error message should display for the cumulative gpa
        if (gpaCumulativeCheckbox.checked) {
          gpaCumulativeError.textContent = `GPA standard is missing the following grades: ${[...window.gpaBadCourses].join(', ')}`;
        }
      }
      if (initialCall) {
        await saveConfig(config.gpa, 'gpa');
      }
    }
    await calculateGpa(true);
    // Show the gpa card after it has been fully configured (only if show mode is enabled)
    if (config.gpa_card?.show_card !== false) {
      gpaCard.style.display = '';
    }    
  });
} else if (/courses\/\d+\/grades/.test(window.location.href)) { // Course grades page
  // Check if the page is valid (if the page is an actual courses' grade page)
  if (document.getElementById('not_found_root') !== null) {
    thisFunctionDoesNotExistAndWasCreatedWithTheOnlyPurposeOfStopJavascriptExecutionOfAllTypesIncludingCatchAndAnyArbitraryWeirdScenario();
  }
  // Adjust the zoom of the page to prevent overlapping from the assignments table and the right side of the page
  const zoomFactor = '83%';
  document.getElementById('assignments').style.zoom = zoomFactor;
  document.getElementById('right-side-wrapper').style.zoom = zoomFactor;
  // Extract the course ID from the URL
  const courseID = RegExp(/courses\/(\d+)\/grades/).exec(window.location.href)[1];
  Promise.resolve(getConfig())
  .then(data => {
   // Get class-specific config
   const config = data[courseID] ?? {};
   // Collect global config from the browser extension storage that is relevant
   const globalConfig = {};
   // Load default settings from config, while using a fallback value if necessary
   globalConfig.grading_standard_default_view = data.grading_standard_default_view ?? true; 
   globalConfig.drops_default_view = data.drops_default_view ?? true;
   globalConfig.class_statistics_default_view = data.class_statistics_default_view ?? true;
   globalConfig.default_grading_standard = data.default_grading_standard ?? null;
   // The classGradingStandard is only for storing the class specified standard (if there is one)
   return [config, globalConfig, null];
  })
  .then(async ([config, globalConfig, classGradingStandard]) => {
    const tableContainer = document.getElementById('assignments-not-weighted');
    // Create table element if it does not exist
    if (tableContainer.querySelector('table.summary:not([id])') === null) {
      const table = document.createElement('table');
      table.classList.add('summary');
      tableContainer.firstElementChild.appendChild(table);
    }
    // Hide the table before it is configured
    const course = await (await fetch(`/api/v1/courses/${courseID}?include[]=total_scores`, {
      method: 'GET'
    })).json();
    const courseAssignments = [];
    let assignmentsPage = 1;
    while (true) {
      const response = await fetch(`/api/v1/courses/${courseID}/assignment_groups?per_page=100&include[]=assignments&include[]=score_statistics&include[]=overrides&include[]=submission&page=${assignmentsPage}`);
      const assignments = await response.json();
      if (assignments.length === 0) {
        break;
      }
      for (const assignment of assignments) {
        courseAssignments.push(assignment);
      }
      assignmentsPage++;
    }
    if (course.grading_standard_id !== null && course.grading_standard_id !== undefined) {
      classGradingStandard = await retrieveGradingStandard(course.id, course.grading_standard_id);
    }
    // If there is no weighting rules in config, then use the class default (if there is one)
    // If the class does not use weighting, then leave the value

    // Initialize table elements if it was just created (table did not exist initially)
    // Use weights from config if they are any, or else leave it blank
    if (!course.apply_assignment_group_weights) {
      // Create elements for the table head
      const thead = document.createElement('thead');
      const thead_row = document.createElement('tr');
      const thead_group = document.createElement('th');
      const thead_weight = document.createElement('th');
      thead_group.scope = 'col';
      thead_group.textContent = 'Group';
      thead_weight.scope = 'col';
      thead_weight.textContent = 'Weight';
      // Add the table head row to the table head
      thead_row.appendChild(thead_group);
      thead_row.appendChild(thead_weight);
      thead.appendChild(thead_row);
      // Create elements for the table body
      const tbody = document.createElement('tbody');
      for (const group of courseAssignments) {
        const tbody_row = document.createElement('tr'); 
        const tbody_group = document.createElement('th');
        const tbody_weight = document.createElement('td');
        tbody_group.scope = 'col';
        tbody_group.textContent = group.name;
        tbody_weight.scope = 'col'; 
        tbody_weight.textContent = config.weights?.[group.name] !== undefined ? +config.weights[group.name].toFixed(2) + '%' : '';
        // Add table body row to the table body
        tbody_row.appendChild(tbody_group);
        tbody_row.appendChild(tbody_weight);
        tbody.appendChild(tbody_row);
      }
      // Add the "Total" row
      const tbody_row_total = document.createElement('tr');
      const tbody_group = document.createElement('th');
      const tbody_weight = document.createElement('td');
      tbody_group.scope = 'col';
      tbody_group.textContent = 'Total';
      tbody_weight.scope = 'col';
      tbody_weight.textContent = '100%';
      tbody_row_total.style.fontWeight = 'bold';
      tbody_row_total.appendChild(tbody_group);
      tbody_row_total.appendChild(tbody_weight);
      tbody.appendChild(tbody_row_total);
      // Add the table head and body
      const table = tableContainer.querySelector('table.summary');
      table.appendChild(thead);
      table.appendChild(tbody);
      table.style.display = 'none';
    }
    // If the table existed initially and if there are weights available, then use these weights
    // If the weights are not complete / invalid (e.g. due to extra groups being added), reset to class default and force save
    if (course.apply_assignment_group_weights && !isObjectEmpty(config.weights)) {
      const tableRows = document.querySelectorAll('table.summary:not([id]) tbody tr');
      // First check for invalid / incomplete weights
      const originalWeights = {};
      let validWeights = true;
      tableRows.forEach((row,idx) => {
        if (idx === tableRows.length - 1) {
          return;
        }
        const curr = config.weights[row.firstElementChild.textContent]; 
        const rowWeight = +row.lastElementChild.textContent.replace('%', '');
        originalWeights[row.firstElementChild.textContent] = rowWeight;
        if (curr === undefined || curr === null) {
          validWeights = false;
        }
        if (isNaN(rowWeight)) {
          console.error(`Row weight is invalid. Excepted number but received ${row.lastElementChild.textContent.replace('%', '')} instead (this shouldn't happen)`);
        }
      });
      if (!validWeights) {
        config.weights = originalWeights;
        await saveConfig(config, courseID);
      }
      // If the weights are not valid, then reset to class default and override config
      // Use original weights map to update rows weights
      // Or else just use the weights from the config
      tableRows.forEach((row,idx) => {
        if (idx === tableRows.length - 1) {
          return;
        }
        row.lastElementChild.textContent = !validWeights ? originalWeights[row.firstElementChild.textContent] + '%' : config.weights[row.firstElementChild.textContent] + '%';
      });
    }
    if (config.use_weighting === undefined) {
      config.use_weighting = course.apply_assignment_group_weights || !isObjectEmpty(config.weights);
    }
    // Function for creating the body for the grading standard table (in the case of a reset, this function is used to rebuild the table)
    const loadGradingStandardTable = function(lowerBounds) {
      // Sort the lower bounds before constructing the table
      const grade_lower_bounds = Object.keys(lowerBounds).sort((a,b) => b-a);
      const tbody = document.createElement('tbody');
      let marker = 0;
      for (const grade of grade_lower_bounds) {
        // Create each row with a cell for the letter grade and the grade scales associated with the current letter grade
        // Also add buttons for row deletion (trash can) and adding new rules (plus icon)
        const tbody_row = document.createElement('tr');
        const tbody_letter_grade = document.createElement('th');
        const tbody_grade = document.createElement('td');
        const tbody_trash = document.createElement('td');
        const trash_button = document.createElement('a');
        const trash_icon = document.createElement('i');
        const add_above_button = document.createElement('a');
        const add_above_icon = document.createElement('i');
        tbody_letter_grade.scope = 'col';
        tbody_letter_grade.textContent = lowerBounds[grade];
        tbody_grade.dataset.lower_bound = grade;
        tbody_grade.scope = 'col';
        tbody_grade.textContent = marker === 0 ? `≥ ${grade}` : (marker === grade_lower_bounds.length - 1 ? `< ${[grade_lower_bounds[marker-1]]}` : `${grade_lower_bounds[marker-1]} > % ≥ ${grade}`);
        trash_icon.classList.add('fas', 'fa-trash');
        trash_button.href = 'javascript:void(0);';
        trash_button.style.color = 'firebrick';
        // Add event listener to the trash can button
        trash_button.addEventListener('click', e => deleteGradingStandardRow(e.target));
        tbody_trash.style.borderBottom = 0;
        tbody_trash.style.display = 'none';
        add_above_icon.classList.add('fas', 'fa-plus-circle');
        add_above_icon.style.backgroundColor = 'white';
        add_above_button.style.color = 'cornflowerblue';
        add_above_button.style.left = '-920%';
        add_above_button.style.position = 'relative';
        add_above_button.style.zIndex = 10;
        add_above_button.style.transform = 'translateY(-50%)';
        add_above_button.style.display = 'none';
        add_above_button.style.fontSize = '.85em';
        add_above_button.href = 'javascript:void(0);';
        add_above_button.classList.add('add_row');
        // Add event listener to the add row button
        add_above_button.addEventListener('click', e => addGradingStandardRow(e.target));
        trash_button.appendChild(trash_icon);
        tbody_trash.appendChild(trash_button);
        add_above_button.appendChild(add_above_icon);
        tbody_row.appendChild(tbody_letter_grade);
        tbody_row.appendChild(tbody_grade);
        tbody_row.appendChild(add_above_button);
        // If the current row is the last row, then include a add row button at the bottom (for adding a row below the current row)
        if (marker === grade_lower_bounds.length - 1) {
          const add_below_button = add_above_button.cloneNode(true);
          add_below_button.style.transform = 'translateY(100%)';
          add_below_button.id = 'add_below';
          // Add event listener to the newly cloned element (event listeners are not cloned)
          add_below_button.addEventListener('click', e => addGradingStandardRow(e.target));
          tbody_row.appendChild(add_below_button);
        }
        tbody_row.appendChild(tbody_trash);
        tbody.appendChild(tbody_row);
        marker++;
      }
      return tbody;
    }
    // Initialize the grading standards table (viewing mode with the lower limit being stored using a data-* attribute) [<elm>.dataset.lower_bound]
    const gradingStandardTable = document.createElement('table');
    const thead = document.createElement('thead');
    const thead_row = document.createElement('tr');
    const thead_letter_grade = document.createElement('th');
    const thead_grade = document.createElement('th');
    const thead_trash = document.createElement('th');
    thead_letter_grade.scope = 'col';
    thead_letter_grade.textContent = 'Letter Grade';
    thead_grade.scope = 'col';
    thead_grade.textContent = 'Grading Scales';
    thead_trash.style.borderBottom = 'none';
    thead_trash.style.width = 0;
    thead_row.appendChild(thead_letter_grade);
    thead_row.appendChild(thead_grade);
    thead_row.appendChild(thead_trash);
    thead.appendChild(thead_row);
    // Load the initial grading standard values (priority is the following: class config -> class grading standard -> global config -> hard-coded default)
    const tbody = loadGradingStandardTable(config.grading_standard ?? classGradingStandard ?? globalConfig.default_grading_standard ?? default_grading_standard);
    gradingStandardTable.appendChild(thead);
    gradingStandardTable.appendChild(tbody);
    // Initialize the assignment drops table
    // Clone thead for the grading standards table and modify it for the assignment drops table
    const dropsTable = document.createElement('table');
    const drops_thead = thead.cloneNode(true);
    drops_thead.firstElementChild.lastElementChild.remove();
    drops_thead.firstElementChild.firstElementChild.textContent = 'Group';
    drops_thead.firstElementChild.lastElementChild.textContent = 'Drops';
    const drops_tbody = document.createElement('tbody');
    for (const group of courseAssignments) {
      const tbody_row = document.createElement('tr'); 
      const tbody_group = document.createElement('th');
      const tbody_drops = document.createElement('td');
      // First try to get drops from config first, then try to get drops from the course rules, or else set the drops as 0
      // For each group, the drops format is an array of the following format: [# of low grades to drop, # of high grades to drop]
      const curr = config.drops?.[group.name] ?? [group.rules.drop_lowest ?? 0, group.rules.drop_highest ?? 0];
      tbody_group.scope = 'col';
      tbody_group.textContent = group.name;
      tbody_drops.scope = 'col';
      tbody_drops.textContent = `${curr[0]} low, ${curr[1]} high`;
      tbody_drops.dataset.low_drops = curr[0];
      tbody_drops.dataset.high_drops = curr[1];
      tbody_row.appendChild(tbody_group);
      tbody_row.appendChild(tbody_drops);
      drops_tbody.appendChild(tbody_row);
    }
    // Add the head and body to the table
    dropsTable.appendChild(drops_thead);
    dropsTable.appendChild(drops_tbody);

    const table = tableContainer.querySelector('table.summary');
    const tableHeader = tableContainer.querySelector('h2');
    // Get the checkbox for determine how grading is done for missing/ungraded assignments (clone the element to remove event listener)
    const tmpCheckbox = document.getElementById('only_consider_graded_assignments');
    tmpCheckbox.parentElement.replaceChild(tmpCheckbox.cloneNode(true), tmpCheckbox);
    const gradingAssignmentsCheckbox = document.getElementById('only_consider_graded_assignments');
    // What-If Scores button
    const showWhatIfScores = document.getElementById('student-grades-whatif').querySelector('button');
    // Revert to Actual Score button
    const hideWhatIfScores = document.getElementById('revert-all-to-actual-score');

    // set active state for table editing (initial state is not editing)
    window.editing = false;
    // If the config is using weighting or if the course has weighting, then set the edit mode to true
    window.editMode = config.use_weighting ?? course.apply_assignment_group_weights;
    window.gradingStandardViewMode = globalConfig.grading_standard_default_view;
    window.gradingStandardMode = null; // null, 'set', 'view'
    window.dropsViewMode = globalConfig.drops_default_view;
    window.dropsMode = null; // null, 'set', 'view'
    window.gradeStatisticsViewMode = globalConfig.class_statistics_default_view;
    // Array for storing the number of points earned and points possible (only relevant for unweighted courses)
    window.coursePoints = null; // if the course is unweighted, then the format will be the following: [points_earned, points_possible]
    // Keep track of the previous grade configuration (null / what-if scores dictionary / "DOM")
    window.previousGradeConfig = null;

    // Create elements that are being added to the grades page
    const editTable = document.createElement('a');
    const saveWeightChanges = document.createElement('a');
    const weightConfig = document.createElement('a');
    const weightsErrorMessage = document.createElement('p');
    const resetWeightsContainer = document.createElement('div');
    const resetWeights = document.createElement('input'); // checkbox
    const resetWeightsLabel = document.createElement('label'); // checkbox label
    const setGradingStandard = document.createElement('a');
    const setDefaultGradingStandardContainer = document.createElement('div');
    const setDefaultGradingStandard = document.createElement('input'); // checkbox
    const setDefaultGradingStandardLabel = document.createElement('label'); // checkbox label
    const resetGradingStandardContainer = document.createElement('div');
    const resetGradingStandard = document.createElement('input'); // checkbox
    const resetGradingStandardLabel = document.createElement('label'); // checbox label
    const gradingStandardCheckboxes = document.createElement('div');
    const saveGradingStandard = document.createElement('a');
    const gradingStandardErrorMessage = document.createElement('p');
    const viewGradingStandard = document.createElement('a');
    const setDrops = document.createElement('a');
    const viewDrops = document.createElement('a');
    const saveDrops = document.createElement('a');
    const dropsErrorMessage = document.createElement('p');
    const resetDropsContainer = document.createElement('div');
    const resetDrops = document.createElement('input'); // checkbox
    const resetDropsLabel = document.createElement('label'); // checkbox label
    const hr = document.createElement('hr');

    // Configure all of the elements that were just created
    table.style.display = window.editMode ? 'inline-table' : 'none';
    tableHeader.textContent = window.editMode ? "Assignments are weighted by group:" : "Course assignments are not weighted."
    editTable.textContent = 'Edit grade weighting';
    editTable.href = 'javascript:void(0);';
    editTable.style.display = 'flex';
    editTable.style.width = 'fit-content';
    saveWeightChanges.textContent = 'Save changes';
    saveWeightChanges.href = 'javascript:void(0);';
    saveWeightChanges.style.display = 'none';
    saveWeightChanges.style.width = 'fit-content';
    weightConfig.href = 'javascript:void(0);';
    weightConfig.style.display = 'none';
    weightConfig.style.float = 'left';
    weightConfig.style.width = 'fit-content';
    weightConfig.textContent = !window.editMode ? "Use weighting for this course" : "Don't use weighting for this course";
    weightsErrorMessage.style.display = 'none';
    weightsErrorMessage.style.color = 'rgb(255,0,0)';
    weightsErrorMessage.style.margin = 0;
    weightsErrorMessage.style.width = 'fit-content';
    resetWeights.type = 'checkbox';
    resetWeights.id = 'reset_weights';
    resetWeights.style.marginRight = '5px';
    resetWeights.style.marginBottom = '-2px';
    resetWeightsLabel.htmlFor = 'reset_weights';
    resetWeightsLabel.textContent = 'Reset weights?';
    resetWeightsLabel.style.userSelect = 'none';
    resetWeightsContainer.style.display = 'none';
    setGradingStandard.style.display = 'flex';
    setGradingStandard.style.width = 'fit-content';
    setGradingStandard.href = 'javascript:void(0);';
    setGradingStandard.textContent = 'Edit grading standard';
    setDefaultGradingStandard.type = 'checkbox';
    setDefaultGradingStandard.id = 'set_default_grading_standard';
    setDefaultGradingStandard.style.marginRight = '5px';
    setDefaultGradingStandard.style.marginBottom = '-2px';
    setDefaultGradingStandardLabel.htmlFor = 'set_default_grading_standard';
    setDefaultGradingStandardLabel.textContent = 'Set as default?';
    setDefaultGradingStandardLabel.style.userSelect = 'none';
    setDefaultGradingStandardContainer.style.display = 'inline';
    resetGradingStandard.type = 'checkbox';
    resetGradingStandard.id = 'reset_grading_standard';
    resetGradingStandard.style.marginRight = '5px';
    resetGradingStandard.style.marginBottom = '-2px';
    resetGradingStandardLabel.htmlFor = 'reset_grading_standard';
    resetGradingStandardLabel.textContent = 'Reset to default?';
    resetGradingStandardLabel.style.userSelect = 'none';
    resetGradingStandardContainer.style.display = 'inline';
    resetGradingStandardContainer.style.marginLeft = '8px';
    gradingStandardCheckboxes.style.display = 'none';
    saveGradingStandard.style.display = 'none';
    saveGradingStandard.style.width = 'fit-content';
    saveGradingStandard.href = 'javascript:void(0);';
    saveGradingStandard.textContent = 'Save changes';
    viewGradingStandard.style.display = 'flex';
    viewGradingStandard.style.width = 'fit-content';
    viewGradingStandard.href = 'javascript:void(0);';
    viewGradingStandard.textContent = window.gradingStandardViewMode ? 'Hide grading standard' : 'Show grading standard';
    gradingStandardErrorMessage.style.display = 'none';
    gradingStandardErrorMessage.style.color = 'rgb(255,0,0)';
    gradingStandardErrorMessage.style.margin = 0;
    gradingStandardErrorMessage.style.width = 'fit-content';
    gradingStandardTable.style.display = window.gradingStandardViewMode ? 'inline-table' : 'none';
    gradingStandardTable.id = 'grading_standard';
    gradingStandardTable.classList.add('summary');
    gradingStandardTable.style.width = '96%';
    gradingStandardTable.style.fontSize = '93%';
    dropsTable.id = 'drops_table';
    dropsTable.classList.add('summary');
    dropsTable.style.width = '96%';
    dropsTable.style.fontSize = '90%';
    dropsTable.style.display = window.dropsViewMode ? 'inline-table' : 'none';
    setDrops.href = 'javascript:void(0);';
    setDrops.style.display = 'flex';
    setDrops.style.width = 'fit-content';
    setDrops.textContent = 'Edit assignment drop rules';
    saveDrops.style.display = 'none';
    saveDrops.style.width = 'fit-content';
    saveDrops.href = 'javascript:void(0);';
    saveDrops.textContent = 'Save changes';
    viewDrops.style.display = 'flex';
    viewDrops.style.width = 'fit-content';
    viewDrops.href = 'javascript:void(0);';
    viewDrops.textContent = window.dropsViewMode ? 'Hide drop rules' : 'Show drop rules';
    dropsErrorMessage.style.display = 'none';
    dropsErrorMessage.style.color = 'rgb(255,0,0)';
    dropsErrorMessage.style.margin = 0;
    dropsErrorMessage.style.width = 'fit-content';
    resetDrops.type = 'checkbox';
    resetDrops.id = 'reset_drops';
    resetDrops.style.marginRight = '5px';
    resetDrops.style.marginBottom = '-2px';
    resetDropsLabel.htmlFor = 'reset_drops';
    resetDropsLabel.textContent = 'Reset drops?';
    resetDropsLabel.style.userSelect = 'none';
    resetDropsContainer.style.display = 'none';
    hr.style.margin = '10px 0';

    // Add elements to the page (all elements are added below the weighting table)
    tableContainer.appendChild(weightsErrorMessage);
    tableContainer.appendChild(editTable);
    tableContainer.appendChild(weightConfig);
    resetWeightsContainer.appendChild(resetWeights);
    resetWeightsContainer.appendChild(resetWeightsLabel);
    tableContainer.appendChild(resetWeightsContainer);
    tableContainer.appendChild(saveWeightChanges);
    tableContainer.appendChild(hr);
    tableContainer.appendChild(dropsTable);
    tableContainer.appendChild(dropsErrorMessage);
    tableContainer.appendChild(setDrops);
    resetDropsContainer.appendChild(resetDrops);
    resetDropsContainer.appendChild(resetDropsLabel);
    tableContainer.appendChild(resetDropsContainer);
    tableContainer.appendChild(saveDrops);
    tableContainer.appendChild(viewDrops);
    tableContainer.appendChild(hr.cloneNode(false));
    tableContainer.appendChild(gradingStandardTable);
    tableContainer.appendChild(gradingStandardErrorMessage);
    tableContainer.appendChild(setGradingStandard);
    setDefaultGradingStandardContainer.appendChild(setDefaultGradingStandard);
    setDefaultGradingStandardContainer.appendChild(setDefaultGradingStandardLabel);
    resetGradingStandardContainer.appendChild(resetGradingStandard);
    resetGradingStandardContainer.appendChild(resetGradingStandardLabel);
    gradingStandardCheckboxes.appendChild(setDefaultGradingStandardContainer);
    gradingStandardCheckboxes.appendChild(resetGradingStandardContainer);
    tableContainer.appendChild(gradingStandardCheckboxes);
    tableContainer.appendChild(saveGradingStandard);
    tableContainer.appendChild(viewGradingStandard);
    // Event listener for editing the class weights table
    editTable.addEventListener('click', () => {
      if (window.editing !== false) {
        return;
      }
      // Get all of the weight cells
      const weightCells = table.querySelectorAll('tbody td');
      // Check if the cells are currently using inputs (instead of just text)
      const inputMode = weightCells[0].firstElementChild !== null;
      resetWeights.checked = false;
      weightCells.forEach((weight,idx) => {
        if (idx === weightCells.length - 1) {
          return;
        }
        // Create a input for configuring the weight for the current assignment group
        const weightInput = document.createElement('input');
        weightInput.type = 'text';
        weightInput.placeholder = '≥ 0';
        weightInput.spellcheck = false;
        weightInput.autocomplete = false;
        weightInput.maxLength = 6;
        weightInput.value = inputMode ? weight.firstElementChild.value : weight.textContent.slice(0,-1);
        weightInput.style.marginBottom = 0;
        weightInput.style.width = '6em';
        // Clear the text content so that the input is the only element in the current weight cell
        weight.textContent = '';
        weight.appendChild(weightInput);
      });
      editTable.style.display = 'none';
      weightConfig.style.display = 'flex';
      saveWeightChanges.style.display = 'flex';
      resetWeightsContainer.style.display = 'inline-block';
      window.editing = true;
    });
    saveWeightChanges.addEventListener('click', async () => {
      if (window.editing !== true) {
        return;
      }
      // Check if the weighting is being reset (do this first as it has priority over any other action)
      // If weights were not being used originally, then use the same state as no weighting
      // Or else get the weights for all assignment groups and update the table
      if (resetWeights.checked && !course.apply_assignment_group_weights) {
        table.style.display = 'none';
        weightConfig.textContent = "Use weighting for this course";
        tableHeader.textContent = "Course assignments are not weighted.";
        weightsErrorMessage.style.display = 'none';
        saveWeightChanges.style.display = 'none';
        weightConfig.style.display = 'none';
        editTable.style.display = 'flex';
        resetWeightsContainer.style.display = 'none';
        window.editMode = false;
        window.editing = false;
        config.use_weighting = false;
        await saveConfig(config, courseID);
        await updateGradeDisplay(null, window.previousGradeConfig);
        return;
      } else if (resetWeights.checked) {
        // Get the weights for each group
        const groupWeights = {};
        for (const group of courseAssignments) {
          groupWeights[group.name] = group.group_weight;
        }
        // Update the rows of the weights table using the weights that were just placed into a dictionary
        const weightRows = document.querySelectorAll('table.summary:not([id]) tbody tr:not(:last-child)');
        for (const row of weightRows) {
          const gradeCell = row.lastElementChild;
          // Remove input
          gradeCell.replaceChildren();
          gradeCell.textContent = groupWeights[row.firstElementChild.textContent] + '%';
        }
        weightsErrorMessage.style.display = 'none';
        saveWeightChanges.style.display = 'none';
        weightConfig.style.display = 'none';
        editTable.style.display = 'flex';
        resetWeightsContainer.style.display = 'none';
        window.editing = false;
        // Delete weights from config (use config set by course unless user explicitly sets weights)
        delete config.weights
        config.use_weighting = true;
        await saveConfig(config, courseID);
        await updateGradeDisplay(null, window.previousGradeConfig);
        return;
      }
      // Check if no weighting mode is toggled
      // If so, then save that rule and do not save anything else
      if (!window.editMode) {
        weightsErrorMessage.style.display = 'none';
        saveWeightChanges.style.display = 'none';
        weightConfig.style.display = 'none';
        editTable.style.display = 'flex';
        tableHeader.textContent = "Course assignments are not weighted.";
        resetWeightsContainer.style.display = 'none';
        window.editing = false;
        config.use_weighting = false;
        await saveConfig(config, courseID);
        await updateGradeDisplay(null, window.previousGradeConfig);
        return;
      }
      const weightInputs = table.querySelectorAll('table.summary:not([id]) tbody input');
      if (weightInputs.length === 0) {
        console.error('Unexpected behavior. No inputs were found');
        return;
      }
      // Perform validation of the inputs and reveal error message if the input is bad
      const values = {};
      let weightSum = 0;
      for (const input of weightInputs) {
        const weight = +input.value;
        // Check for non-numerical or negative weights
        if (isNaN(weight) || weight < 0) {
          weightsErrorMessage.style.display = 'flex';
          weightsErrorMessage.textContent = "Please use non-negative numerical values for the weights";
          return;
        }
        weightSum += weight;
        values[input.parentElement.previousElementSibling.textContent] = weight;
      }
      // Reveal an error message if the weights don't add up to a value > 0
      if (weightSum <= 0) {
        weightsErrorMessage.style.display = 'flex';
        weightsErrorMessage.textContent = "Please make sure that the weights you provided add up to a positive value";
        return;
      }
      // Compute constant for scaling weights (so that total is 100)
      const k = 100 / weightSum;
      let inputIdx = 0;
      let scaledWeightSum = 0;
      // Configure each of the weighting table cells 
      for (const input of weightInputs) {
        const tableCell = input.parentElement;
        if (inputIdx === weightInputs.length - 1) {
          const diff = +((10000 - scaledWeightSum) / 100).toFixed(2);
          values[tableCell.previousElementSibling.textContent] = diff;
          tableCell.textContent = diff + '%';
          scaledWeightSum += 100 * diff;
          continue;
        }
        values[tableCell.previousElementSibling.textContent] = +(k * values[tableCell.previousElementSibling.textContent]).toFixed(2);
        tableCell.textContent = values[tableCell.previousElementSibling.textContent] + '%';
        scaledWeightSum += 100 * values[tableCell.previousElementSibling.textContent];
        inputIdx++;
      }
      // If the sum is still not 100, something is wrong (this has tested though so it should work -- there may be a tiny amount of error in the scaling process)
      if (scaledWeightSum !== 10000) {
        console.error('Scaled sum is not 100. Something went wrong', scaledWeightSum);
      }
      // Hide error message on success
      weightsErrorMessage.style.display = 'none';
      saveWeightChanges.style.display = 'none';
      weightConfig.style.display = 'none';
      editTable.style.display = 'flex';
      resetWeightsContainer.style.display = 'none';
      window.editing = false;
      // If no weighting existing before save or if not all weights are the same, then save weighting normally, else drop weighting from config
      const changesMade = !course.apply_assignment_group_weights || !courseAssignments.every(group => 
        group.group_weight === values[group.name]
      );
      if (changesMade) {
        config.weights = values;
      } else {
        delete config.weights;
      }
      config.use_weighting = true;
      // Save config and update the grade display
      await saveConfig(config, courseID);
      // TODO Consider changing this so that only the weights have to be recalculated (store assignment group calculations in a window variable)
      await updateGradeDisplay(null, window.previousGradeConfig);
    });
    weightConfig.addEventListener('click', () => {
      if (window.editing !== true) {
        return;
      }
      // If weighting is currently being used, then disable it
      // Or else enable weighting (if it is disabled)
      if (window.editMode) {
        table.style.display = 'none';
        weightConfig.textContent = "Use weighting for this course";
        tableHeader.textContent = "Course assignments are not weighted.";
      } else {
        table.style.display = 'inline-table'; // Revert to original display style
        weightConfig.textContent = "Don't use weighting for this course";
        tableHeader.textContent = "Assignments are weighted by group:";
      }
      window.editMode = !window.editMode;
      weightsErrorMessage.style.display = 'none';
    });
    setGradingStandard.addEventListener('click', () => {
      // 'view' or null is acceptable
      if (window.gradingStandardMode === 'set') {
        return;
      }      
      const gradingStandardRows = document.querySelectorAll('#grading_standard tbody tr');
      // Check if the table was previously in editing mode (check if there is an input element)
      const inputMode = gradingStandardRows[0].firstElementChild.firstElementChild !== null;
      // Reset grading standard checkboxes
      setDefaultGradingStandard.checked = false;
      setDefaultGradingStandard.disabled = false;
      resetGradingStandard.checked = false;
      resetGradingStandard.disabled = false;
      // Nothing to do if the table is already using inputs (table cells do not need to be modified)
      if (inputMode) {
        gradingStandardTable.style.display = 'inline-table';
        setGradingStandard.style.display = 'none';
        saveGradingStandard.style.display = 'flex';
        gradingStandardCheckboxes.style.display = 'inline-block';
        viewGradingStandard.style.display = 'none';
        window.gradingStandardMode = 'set';
        return;
      }
      for (const row of gradingStandardRows) {
        // Get the cell for the letter grade and the lower grade threshold
        const letterGradeCell = row.firstElementChild;
        const lowerGradeThresholdCell = row.children[1];
        const trashCell = row.lastElementChild;
        const addButtonAbove = row.children[2];
        const addButtonBelow = row.nextElementSibling === null ? row.children[3] : null; 
        const letterGradeInput = document.createElement('input');
        const gradeInput = document.createElement('input');        
        // Configure input attributes
        letterGradeInput.type = 'text';
        letterGradeInput.placeholder = '';
        letterGradeInput.spellcheck = false;
        letterGradeInput.autocomplete = false;
        letterGradeInput.maxLength = 2;
        letterGradeInput.style.width = '60%';
        letterGradeInput.style.marginBottom = 0;
        letterGradeInput.value = letterGradeCell.textContent;
        letterGradeCell.textContent = '';
        gradeInput.type = 'text';
        gradeInput.placeholder = '0-100';
        gradeInput.spellcheck = false;
        gradeInput.autocomplete = false;
        gradeInput.maxLength = 5; // allow for numbers with decimals (e.g 93.5 or 97.25)
        gradeInput.style.width = '75%';    
        gradeInput.style.marginBottom = 0;
        gradeInput.value = lowerGradeThresholdCell.dataset.lower_bound;
        lowerGradeThresholdCell.textContent = '';
        // Show the delete row and add row buttons 
        trashCell.style.display = '';
        addButtonAbove.style.display = 'inline-block';
        // If the current row is the last row, we also need to show the add row below button
        if (addButtonBelow !== null) {
          addButtonBelow.style.display = 'inline-block';
        }
        // Add the inputs to each of the cells of the grading standard table
        letterGradeCell.appendChild(letterGradeInput);
        lowerGradeThresholdCell.appendChild(gradeInput);
      }
      // Update the table header for the 
      gradingStandardTable.firstElementChild.firstElementChild.children[1].textContent = 'Lower Grade Threshold (%)';
      gradingStandardTable.style.display = 'inline-table';
      setGradingStandard.style.display = 'none';
      saveGradingStandard.style.display = 'flex';
      gradingStandardCheckboxes.style.display = 'inline-block';
      viewGradingStandard.style.display = 'none';
      window.gradingStandardMode = 'set';
    });
    saveGradingStandard.addEventListener('click', async () => {
      // only 'set' is acceptable
      if (window.gradingStandardMode !== 'set') {
        return;
      }
      // Check if reset grading standard button is checked
      // If so, then remove the table body and regenerate it
      if (resetGradingStandard.checked) {
        gradingStandardTable.querySelector('tbody').remove();
        const fallbackGradingStandard = classGradingStandard ?? globalConfig.default_grading_standard ?? default_grading_standard;
        gradingStandardTable.appendChild(loadGradingStandardTable(fallbackGradingStandard));
        // Perform additional updates before saving
        gradingStandardErrorMessage.textContent = '';
        saveGradingStandard.style.display = 'none';
        gradingStandardCheckboxes.style.display = 'none';
        gradingStandardErrorMessage.style.display = 'none';
        gradingStandardTable.style.display = 'none';
        setGradingStandard.style.display = 'flex';
        viewGradingStandard.style.display = 'flex';
        gradingStandardTable.firstElementChild.firstElementChild.children[1].textContent = 'Grading Scales';
        window.gradingStandardMode = null;
        // If the grading standard was being viewed before editing, then show the grading standard table  
        gradingStandardTable.style.display = window.gradingStandardViewMode ? 'inline-table' : 'none'; 
        // Remove grading standard then save config (important to remove since other code relies on nullish coalescing, which doesn't propagate on empty objects)
        delete config.grading_standard;
        await saveConfig(config, courseID);
        // Update letter grade for the grade display (no grade recalculations required - percentages are stored in window.courseGrades as an array [you, q1, q2, q3, mean])
        await updateGradeDisplay(window.courseGrades);
        return;
      }
      // First check if the data provided by the inputs is valid
      const grading_standard = {}; // key: grade, value: letter grade
      const gradingStandardRows = Array.from(document.querySelectorAll('#grading_standard tbody tr'));
      const gradingStandardBody = gradingStandardRows[0].parentElement;
      const letterGrades = new Set();
      for (const row of gradingStandardRows) {
        const letterGrade = row.firstElementChild.firstElementChild.value.toUpperCase();
        row.firstElementChild.firstElementChild.value = letterGrade;
        const lowerGradeThreshold = +row.children[1].firstElementChild.value;
        if (letterGrade.trim() === '') {
          gradingStandardErrorMessage.textContent = "Please don't leave the input for the letter grade blank";
          gradingStandardErrorMessage.style.display = 'flex';
          return;
        }
        if (isNaN(lowerGradeThreshold) || lowerGradeThreshold < 0) {
          gradingStandardErrorMessage.textContent = "Please use non-negative numerical values for the lower grade threshold";
          gradingStandardErrorMessage.style.display = 'flex';
          return;
        }
        if (grading_standard[lowerGradeThreshold]) {
          gradingStandardErrorMessage.textContent = "Please don't use duplicate values for the lower grade threshold";
          gradingStandardErrorMessage.style.display = 'flex';
          return;
        }
        if (letterGrades.has(letterGrade)) {
          gradingStandardErrorMessage.textContent = "Please don't use duplicate values for the letter grade";
          gradingStandardErrorMessage.style.display = 'flex';
          return;
        }
        grading_standard[lowerGradeThreshold] = letterGrade;
        letterGrades.add(letterGrade);
      }
      // Sort rows in descending order of grade (rows will be sorted for view mode and edit mode)
      gradingStandardRows.sort((a,b) => b.children[1].firstElementChild.value - a.children[1].firstElementChild.value);
      // If the input is valid, then configure the cells
      // Re-append rows (since the elements are already in the DOM, they will be moved to their new location (this will sort the rows in descending order)
      // Reference: https://developer.mozilla.org/en-US/docs/Web/API/Node/appendChild#sect1
      for (const row of gradingStandardRows) {
        const gradeCell = row.children[1];
        gradeCell.dataset.lower_bound = gradeCell.firstElementChild.value;
        gradingStandardBody.appendChild(row);
      }
      gradingStandardErrorMessage.textContent = '';
      saveGradingStandard.style.display = 'none';
      gradingStandardCheckboxes.style.display = 'none';
      gradingStandardErrorMessage.style.display = 'none';
      gradingStandardTable.style.display = 'none';
      setGradingStandard.style.display = 'flex';
      viewGradingStandard.style.display = 'flex';
      gradingStandardTable.firstElementChild.firstElementChild.children[1].textContent = 'Grading Scales';
      window.gradingStandardMode = null;
      // If the grading standard was being viewed before editing, then show the grading standard table
      if (window.gradingStandardViewMode) {
        toggleGradingStandardTable();
      }
      // If the changes made are the same as the fallback, then drop the grading standard then save the config
      const fallbackGradingStandard = classGradingStandard ?? globalConfig.default_grading_standard ?? default_grading_standard;
      const gradingStandardKeys = Object.keys(grading_standard); 
      const changesMade = gradingStandardKeys.length !== Object.keys(fallbackGradingStandard).length || !gradingStandardKeys.every(key =>
        grading_standard[key] === fallbackGradingStandard[key]
      );
      if (changesMade) {
        config.grading_standard = grading_standard;
      } else {
        delete config.grading_standard;
      }
      await saveConfig(config, courseID);
      if (setDefaultGradingStandard.checked) {
        await saveConfig(grading_standard, 'default_grading_standard');
      }
      // Update letter grade for the grade display (no grade recalculations required - percentages are stored in window.courseGrades as an array [you, q1, q2, q3, mean])
      await updateGradeDisplay(window.courseGrades);
    });
    // Function for toggling the view of the grading standard table
    const toggleGradingStandardTable = function() {
      // Any state of window.gradingStandardMode is acceptable
      const gradingStandardRows = document.querySelectorAll('#grading_standard tbody tr');
      // Check if the table was previously in editing mode (check if there is an input element)
      const inputMode = gradingStandardRows[0].firstElementChild.firstElementChild !== null;
      // Nothing to do if the table does not use inputs already  
      if (!inputMode) {
        viewGradingStandard.textContent = window.gradingStandardViewMode ? 'Show grading standard' : 'Hide grading standard';
        gradingStandardTable.style.display = window.gradingStandardViewMode ? 'none' : 'inline-table';
        window.gradingStandardMode = window.gradingStandardViewMode ? 'view' : null;
        window.gradingStandardViewMode = !window.gradingStandardViewMode;
        setGradingStandard.style.display = 'flex';
        saveGradingStandard.style.display = 'none';
        return;
      }
      let marker = 0;
      for (const row of gradingStandardRows) {
        // Access all important elements in the current row
        const letterGradeCell = row.firstElementChild;
        const lowerGradeThresholdCell = row.children[1];
        const trashCell = row.lastElementChild;
        const addRow = row.children[2];
        const letterGrade = letterGradeCell.firstElementChild.value;
        const lowerGradeThreshold = +lowerGradeThresholdCell.dataset.lower_bound;
        // Replace the inputs from the table cells with text
        // First remove the inputs from both cells in the current row
        letterGradeCell.replaceChildren();
        lowerGradeThresholdCell.replaceChildren();
        // Replace the inputs in the cells with text
        letterGradeCell.textContent = letterGrade;
        lowerGradeThresholdCell.textContent = marker === 0 ? `≥ ${lowerGradeThreshold}` : ((marker === gradingStandardRows.length - 1 && lowerGradeThreshold === 0) ? `< ${gradingStandardRows[marker-1].children[1].dataset.lower_bound}` : `${gradingStandardRows[marker-1].children[1].dataset.lower_bound} > % ≥ ${lowerGradeThreshold}`);
        trashCell.style.display = 'none';
        addRow.style.display = 'none';
        marker++;
      }
      // Hide the add below button
      document.getElementById('add_below').style.display = 'none';
      window.gradingStandardMode = 'view';
      viewGradingStandard.textContent = 'Hide grading standard';
      gradingStandardTable.style.display = 'inline-table';
      viewGradingStandard.style.display = 'flex';
      window.gradingStandardViewMode = true;
    }
    viewGradingStandard.addEventListener('click', toggleGradingStandardTable);
    resetGradingStandard.addEventListener('change', () => {
      // If the reset grading standard checkbox is ticked, then disable the default grading standard checkbox
      if (resetGradingStandard.checked) {
        setDefaultGradingStandard.checked = false;
        setDefaultGradingStandard.disabled = true;
      } else {
        setDefaultGradingStandard.disabled = false;
      }
    });
    setDefaultGradingStandard.addEventListener('change', () => {
      // If the default grading standard checkbox is ticked, then disable the reset graidng standard checkbox
      if (setDefaultGradingStandard.checked) {
        resetGradingStandard.checked = false;
        resetGradingStandard.disabled = true;
      } else {
        resetGradingStandard.disabled = false;
      }
    });
    setDrops.addEventListener('click', () => {
      if (window.dropsMode === 'set') {
        return;
      }
      const dropsRows = document.querySelectorAll('#drops_table tbody tr');
      // Check if the table was previously in editing mode (check if there is an input element)
      const inputMode = dropsRows[0].lastElementChild.firstElementChild !== null;
      resetDrops.checked = false;
      // Nothing to do if the table is already using inputs
      if (inputMode) {
        dropsTable.style.display = 'inline-table';
        setDrops.style.display = 'none';
        saveDrops.style.display = 'flex';
        viewDrops.style.display = 'none';
        resetDropsContainer.style.display = 'inline';
        window.dropsMode = 'set';
        return;
      }
      let marker = 0;
      for (const row of dropsRows) {
        const dropsCell = row.lastElementChild;
        // Create input elements with labels
        const lowDropsInput = document.createElement('input');
        const lowDropsLabel = document.createElement('label');
        const highDropsInput = document.createElement('input');
        const highDropsLabel = document.createElement('label');
        const inputsContainer = document.createElement('div');
        // Configure attributes of the newly created elements
        lowDropsInput.type = 'text';
        lowDropsInput.placeholder = '0-99';
        lowDropsInput.spellcheck = false;
        lowDropsInput.autocomplete = false;
        lowDropsInput.maxLength = 2;
        lowDropsInput.style.width = '15%';
        lowDropsInput.style.marginBottom = 0;
        lowDropsInput.style.marginRight = '10px';
        lowDropsInput.style.textAlign = 'center';
        lowDropsInput.value = +dropsCell.dataset.low_drops;
        lowDropsInput.id = 'low_drops_input_' + marker;
        highDropsInput.type = 'text';
        highDropsInput.placeholder = '0-99';
        highDropsInput.spellcheck = false;
        highDropsInput.autocomplete = false;
        highDropsInput.maxLength = 2;
        highDropsInput.style.width = '15%';
        highDropsInput.style.marginBottom = 0;
        highDropsInput.style.textAlign = 'center';
        highDropsInput.value = +dropsCell.dataset.high_drops;
        highDropsInput.id = 'high_drops_input_' + marker;
        inputsContainer.style.marginBottom = '10px';
        lowDropsLabel.htmlFor = 'low_drops_input_' + marker;
        lowDropsLabel.textContent = 'Low';
        lowDropsLabel.style.position = 'absolute';
        lowDropsLabel.style.transform = 'translate(5px,37px)';
        lowDropsLabel.style.fontSize = '85%';
        lowDropsLabel.style.color = 'gray';
        highDropsLabel.htmlFor = 'high_drops_input_' + marker;
        highDropsLabel.textContent = 'High';
        highDropsLabel.style.position = 'absolute';
        highDropsLabel.style.transform = 'translate(55px,37px)';
        highDropsLabel.style.fontSize = '85%';
        highDropsLabel.style.color = 'gray';
        // Clear text in the drops cell (text is being replaced with a text input)
        dropsCell.textContent = '';
        // Add newly created elements to the current row in the drops table
        dropsCell.appendChild(lowDropsLabel);
        dropsCell.appendChild(highDropsLabel);
        inputsContainer.appendChild(lowDropsInput);
        inputsContainer.appendChild(highDropsInput);
        dropsCell.appendChild(inputsContainer);
        marker++;
      }
      // Show the table after configuring it for input mode
      dropsTable.style.display = 'inline-table';
      setDrops.style.display = 'none';
      saveDrops.style.display = 'flex';
      viewDrops.style.display = 'none';
      resetDropsContainer.style.display = 'inline';
      window.dropsMode = 'set';
    });
    saveDrops.addEventListener('click', async () => {
      if (window.dropsMode !== 'set') {
        return;
      }
      const defaultMap = {};
      // If the reset drops checkbox is ticked, then use the drop counts from the class rules, or else use 0 if the class rule is not present
      if (resetDrops.checked) {
        for (const group of courseAssignments) {
          defaultMap[group.name] = [group.rules.drop_lowest ?? 0, group.rules.drop_highest ?? 0];
        }
      }
      const dropRules = {};
      const dropsRows = document.querySelectorAll('#drops_table tbody tr');
      let marker = 0;
      for (const row of dropsRows) {
        const groupName = row.firstElementChild.textContent;
        // If reset drops is set, then upate the input value to the count provided by the class rules, or 0 if there isn't a given value 
        if (resetDrops.checked) {
          row.lastElementChild.lastElementChild.firstElementChild.value = defaultMap[groupName][0];
          row.lastElementChild.lastElementChild.lastElementChild.value = defaultMap[groupName][1];
        }
        // Read value from the input and perform validation before adding the value to the drop rules map
        const lowDrops = +row.lastElementChild.lastElementChild.firstElementChild.value;
        const highDrops = +row.lastElementChild.lastElementChild.lastElementChild.value;
        // Display error message if any of the inputs contain a "bad" value
        if (isNaN(lowDrops) || isNaN(highDrops) || lowDrops < 0 || highDrops < 0 || lowDrops % 1 !== 0 || highDrops % 1 !== 0) {
          dropsErrorMessage.textContent = "Please use whole non-negative numerical values for the low/high drop count";
          dropsErrorMessage.style.display = 'flex';
          return;
        }
        dropRules[groupName] = [lowDrops, highDrops];
        marker++;
      }
      dropsErrorMessage.textContent = '';
      dropsErrorMessage.style.display = 'none';
      dropsTable.style.display = 'none';
      viewDrops.style.display = 'flex';
      saveDrops.style.display = 'none';
      setDrops.style.display = 'flex';
      resetDropsContainer.style.display = 'none';
      window.dropsMode = null;
      // If the drops table was original being viewed before editing, then re-display the drops table
      if (window.dropsViewMode) {
        toggleDropsTable();
      }
      // Check if the changes result in the rules set by the class. If so, then remove drops config 
      // This behavior should be implemented since the user will want to stay up-to-date with all course updates and not fall behind due to "useless"/expired config  
      const changesMade = !courseAssignments.every(group => {
        const [lowest, highest] = dropRules[group.name];
        return (group.rules.drop_lowest ?? 0) === lowest && (group.rules.drop_highest ?? 0) === highest; 
      });
      // Modify config before saving the config to storage and updating the grade display (remove drops if changes were not made)
      if (changesMade) {
        config.drops = dropRules;
      } else {
        delete config.drops;
      }
      await saveConfig(config, courseID);
      await updateGradeDisplay(null, window.previousGradeConfig);
    });
    const toggleDropsTable = function() {
      const dropsRows = Array.from(document.querySelectorAll('#drops_table tbody tr'));
      const inputMode = dropsRows[0].lastElementChild.firstElementChild !== null;
      // Nothing to do if the table does not contain any inputs
      if (!inputMode) {
        viewDrops.textContent = window.dropsViewMode ? 'Show drop rules' : 'Hide drop rules';
        dropsTable.style.display = window.dropsViewMode ? 'none' : 'inline-table';
        window.dropsMode = window.dropsViewMode ? 'view' : null;
        window.dropsViewMode = !window.dropsViewMode;
        setDrops.style.display = 'flex';
        saveDrops.style.display = 'none';
        return;
      }
      for (const row of dropsRows) {
        const dropsCell = row.lastElementChild;
        const lowDrops = +dropsCell.lastElementChild.firstElementChild.value;
        const highDrops = dropsCell.lastElementChild.lastElementChild.value;
        // Replace the inputs in the drops cell with text
        dropsCell.replaceChildren();
        dropsCell.textContent = `${lowDrops} low, ${highDrops} high`;
        // Set the values in the dataset
        dropsCell.dataset.low_drops = lowDrops;
        dropsCell.dataset.high_drops = highDrops; 
      }
      window.dropsMode = 'view';
      viewDrops.textContent = 'Hide drop rules';
      dropsTable.style.display = 'inline-table';
      viewDrops.style.display = 'flex';
      window.dropsViewMode = true;
    }
    viewDrops.addEventListener('click', toggleDropsTable);
    gradingAssignmentsCheckbox.addEventListener('change', async () => await updateGradeDisplay(null, window.previousGradeConfig));
    showWhatIfScores.addEventListener('click', async () => {
      // Fetch grades using GraphQL API
      const whatIfScores = (await (await (fetch('/api/graphql', {
        headers: {
          "content-type": "application/json",
           // Retrieve token required to make a request from the API (token is stored in the user's cookies)
          "x-csrf-token": decodeURIComponent((/(^|;) *_csrf_token=([^;]*)/.exec(document.cookie) || '')[2]),
        },
        // GraphQL query
        body: `{"query":"query whatIfGrades($courseId: ID!) {\\n  course(id: $courseId) {\\n    submissionsConnection(filter: { states:[submitted, unsubmitted, pending_review, graded, ungraded] } ) {\\n      nodes {\\n        assignment {\\n          _id\\n       }\\n        score\\n        studentEnteredScore\\n      }\\n    }\\n  }\\n}","variables":{"courseId":${courseID}}}`,
        method: "POST",
      }))).json()).data.course.submissionsConnection.nodes;
      // Store the What-If grades that are available in a dictionary
      const whatIfScoresDict = {};
      for (const scoreObj of whatIfScores) {
        const whatIfScore = scoreObj.studentEnteredScore ?? null;
        if (whatIfScore === null || whatIfScore === scoreObj.score) {
          continue; 
        }
        whatIfScoresDict[scoreObj.assignment._id] = whatIfScore;
      }
      if (isObjectEmpty(whatIfScoresDict)) {
        showWhatIfScores.style.display = 'none';
        return;
      }
      // Toggle the state of the what-if grades buttons (fixes Canvas bug)
      showWhatIfScores.parentElement.style.display = 'none';
      hideWhatIfScores.parentElement.style.display = 'block';
      // Update grades using the what-if grades (if there are any)
      window.previousGradeConfig = whatIfScoresDict;
      await updateGradeDisplay(null, whatIfScoresDict);
    });
    hideWhatIfScores.addEventListener('click', async () => {
      // Revert to original scores (use values stored in window.courseGrades)
      showWhatIfScores.parentElement.style.display = 'block';
      hideWhatIfScores.parentElement.style.display = 'none';
      // Update grades using normal grade calculation 
      // TODO Consider storing the original data so that you can easily revert back
      window.previousGradeConfig = null;
      await updateGradeDisplay(null);
    });
    // Mutation observer for checking if any assignment grades are changed (checking for the removal of a text input that is used to set a what-if grade)
    const observer = new MutationObserver((mutationList, _observer) => {
      for (const mutation of mutationList) {
        if (mutation.removedNodes && mutation.removedNodes.length === 1 && mutation.removedNodes[0].id === 'grade_entry') {
          const newValue = mutation.removedNodes[0].value.trim();
          if (newValue === '' || isNaN(+newValue)) {
            continue;
          }
          window.previousGradeConfig = 'DOM';
          updateGradeDisplay(null, 'DOM');
          break;
        }
      }
    });
    const deleteGradingStandardRow = function(elm) {
      // Iterate up the DOM tree to get the current row of the trash button
      while (elm !== null && elm.tagName !== 'TR') {
        elm = elm.parentElement;
      }
      // Throw an error if the row was never found (this shouldn't happen)
      if (elm === null) {
        throw new Error("Something unexpected happened when attempting to delete a row from the grading standard table");
      }
      // Delete current row ('element') from the grade standards table
      const rowCount = gradingStandardTable.lastElementChild.childElementCount;
      // Don't delete if the number of rows in the table is 2 or less 
      if (rowCount <= 2) {
        return;
      }
      // If the number of rows is 3, then hide all of the trash can icons (functionality will also be disabled by the conditional above)
      if (rowCount === 3) {
        gradingStandardTable.querySelectorAll('tbody td:last-child').forEach(trashCell => {
          trashCell.style.visibility = 'hidden';
        });
      } else if (rowCount === 18) {
        // Re-display the add button is the count is 18 (allow the user to add rows again)
        gradingStandardTable.querySelectorAll('tbody .add_row').forEach(addButton => {
          addButton.style.display = 'inline-block';
        });
      }
      // Check if the current row is the last row (the add below button is in the last row so this case is important)
      const specialCase = elm.nextElementSibling === null;
      if (specialCase) {
        // Move the add bottom button to the previous row
        const prev = elm.previousElementSibling;
        const addBelowButton = document.getElementById('add_below');
        prev.querySelector('.add_row').insertAdjacentElement('afterend', addBelowButton);
      }
      // Remove the current row
      elm.remove();
    }
    const addGradingStandardRow = function(elm) {
      let addRowButton = null;
      // Iterate up the DOM tree to get the current row of the add button
      while (elm !== null && elm.tagName !== 'TR') {
        // Get the add row button when you pass by it during iteration
        if (elm.tagName === 'A') {
          addRowButton = elm; 
        }
        elm = elm.parentElement;
      }
      // Throw an error if the row or add button was never found (this shouldn't happen)
      if (elm === null || addRowButton === null) {
        throw new Error("Something unexpected happened when attempting to add a row to the grading standard table");
      }
      const rowCount = gradingStandardTable.lastElementChild.childElementCount;
      // Don't add another row if the number of rows in the table is 18 or more 
      if (rowCount >= 18) {
        return;
      }
      // If the number of rows is 17, then hide all of the add row buttons (functionally will also be disabled by the conditional above)
      if (rowCount === 17) {
        gradingStandardTable.querySelectorAll('tbody .add_row').forEach(addButton => {
          addButton.style.display = 'none';
        });
      } else if (rowCount === 2) {
        // Unhide all buttons for deleting a row
        gradingStandardTable.querySelectorAll('tbody td:last-child').forEach(trashCell => {
          trashCell.style.visibility = 'visible';
        });
      }
      // Check for the special case (new row is being added using the add below button)
      const specialCase = addRowButton.id === 'add_below';
      // Check if the current row is the last row
      const isLastRow = elm.nextElementSibling === null; 
      // Clone the current row
      const newRow = elm.cloneNode(true);
      // If the special case applies, then strip the add row below button of its unique id, and give it to the add row below button in the newly cloned row
      if (specialCase) {
        addRowButton.id = '';
        const newRowAddButton = newRow.children[3];
        newRowAddButton.id = 'add_below';
        newRowAddButton.addEventListener('click', e => addGradingStandardRow(e.target));
        addRowButton.remove();
      }
      // If the row that contains the add row button is the last row (but the button is not add row below)
      if (isLastRow && !specialCase) {
        newRow.querySelector('#add_below').remove();
      }
      // Add event listener to the newly cloned element since event listeners are not copied 
      // Source: https://developer.mozilla.org/en-US/docs/Web/API/Node/cloneNode
      newRow.firstElementChild.firstElementChild.value = '';
      newRow.children[1].firstElementChild.value = '';
      newRow.children[2].addEventListener('click', e => addGradingStandardRow(e.target));
      newRow.lastElementChild.addEventListener('click', e => deleteGradingStandardRow(e.target));
      elm.insertAdjacentElement(specialCase ? 'afterend' : 'beforebegin', newRow);
    }
    // Do this immediately because drops do not update properly on what-if grades
    const updateGradeDisplay = async function(grades, whatIfScores = null) {
      const gradesText = document.querySelectorAll('.student_assignment.final_grade');
      if (grades === null) {
        grades = await getCourseGrade(course, config, courseAssignments, whatIfScores, true);
      }
      // gradesArr = [your grade, q1, q2, q3, mean]
      const gradesArr = await Promise.all(grades.slice(0,5).map(async grade => {
        return {
          grade,
          // Select the best grading standard values (priority is the following: class config -> class grading standard -> global config -> hard-coded default)
          letterGrade: await getLetterGrade(config.grading_standard ?? classGradingStandard ?? globalConfig.default_grading_standard ?? default_grading_standard, grade)
        }
      }));
      const low = grades[5];
      const high = grades[6];
      const gradesList = [null,'Lower Quartile','Median','Upper Quartile','Mean'];
      window.courseGrades = grades; // response: [you, q1, q2, q3, mean, low, high] {grades are provided in an array of length 7}
      gradesText.forEach(grade => {
        if (grade.nodeName === 'DIV') {
          // Right side grade display
          const gradeStatisticsContainer = document.createElement('div');
          gradeStatisticsContainer.id = 'grade_statistics';
          let marker = 0;
          for (const elm of gradesArr) {
            // Special case for adding the percentile text
            if (marker === 0) {
              grade.replaceChildren(document.createElement('span'));
              // Set the percentage grade text on the course page to the following format: "Total: <grade>% (<letterGrade>)"
              grade.firstElementChild.textContent = elm.grade === 'NG' ? 'Total: No Grade (NG)' : `Total: ${elm.grade}%\u2004(${elm.letterGrade})`;
              // Remove the "grade" class so that Canvas cannot interact with the grade display
              grade.firstElementChild.classList.remove('grade');
              // If the class statistics are -1, then they are unavailable, so exit the loop
              if (gradesArr[1].grade === -1) {
                break;
              }
              // Get class percentile
              const percentile = calculatePercentile(gradesArr[1].grade, gradesArr[2].grade, gradesArr[3].grade, gradesArr[0].grade, low, high);
              // Set the top percentile text and style it
              const topPercentile = document.createElement('span');
              topPercentile.textContent = percentile !== null && !isNaN(percentile) ? `[Top ${Math.round(1e4 - (100 * percentile)) / 100}%]` : '[Top: N/A]';
              topPercentile.style.fontSize = '80%';
              topPercentile.style.marginLeft = '.75vw';
              topPercentile.style.fontWeight = 900;
              topPercentile.id = 'grade_percentile'; // use this for toggling the display
              grade.appendChild(topPercentile);
              // Add a horizontal line for styling
              const hr = document.createElement('hr');
              hr.style.margin = '5px';
              gradeStatisticsContainer.appendChild(hr);
              marker++;
              continue;
            }
            const statGradeTitle = document.createElement('span');
            statGradeTitle.textContent = ` ${gradesList[marker]}: `;
            statGradeTitle.style.fontSize = '85%';
            const statGrade = document.createElement('span');
            statGrade.style.fontSize = '85%';
            statGrade.textContent = `${elm.grade}% (${elm.letterGrade})`;
            gradeStatisticsContainer.appendChild(statGradeTitle);
            gradeStatisticsContainer.appendChild(statGrade);
            gradeStatisticsContainer.appendChild(document.createElement('br'));
            marker++;
            // If the statistics are valid (loop was not broken), then add the statistics container
            if (marker === gradesArr.length) {
              grade.appendChild(gradeStatisticsContainer);
            }
          }
          // Create button for toggling grade statistics if it doesn't exist already
          const toggleGradeStatistics = document.getElementById('toggle_grade_statistics') ?? document.createElement('a');
          // If the grade statistics are not available, then hide the toggle button and don't do anything else
          if (gradesArr[1].grade === -1) {
            toggleGradeStatistics.style.display = 'none';
            toggleGradeStatistics.textContent = '';
            toggleGradeStatistics.href = '';
            return;
          }
          // Function to toggling the display of the class statistics for the current class
          const gradeStatisticsDisplay = function(changingState) {
            const percentile = document.getElementById('grade_percentile');
            const statistics = document.getElementById('grade_statistics');
            // Exit early if the percentile or statistics elements do not exist (should not happen)
            if (percentile === null || statistics === null) {
              console.error('Percentile or statistics do not exist', percentile, statistics);
              return;
            }
            // If the state is being maintained then flip it early (it will be reset later in the function)
            if (!changingState) {
              window.gradeStatisticsViewMode = !window.gradeStatisticsViewMode;
            }
            if (window.gradeStatisticsViewMode) {
              // Hide top percentile and statistics
              percentile.style.display = 'none';
              statistics.style.display = 'none';
              toggleGradeStatistics.textContent = 'Show class statistics';
            } else {
              // Show top percentile and statistics
              percentile.style.display = '';
              statistics.style.display = '';
              toggleGradeStatistics.textContent = 'Hide class statistics';
            }
            window.gradeStatisticsViewMode = !window.gradeStatisticsViewMode;
          }
          // If the toggle grade statistics button is newly created, then configure it
          if (toggleGradeStatistics.id === '') {
            gradeStatisticsContainer.id = 'grade_statistics';
            toggleGradeStatistics.style.display = 'flex';
            toggleGradeStatistics.style.width = 'fit-content';
            toggleGradeStatistics.style.userSelect = 'none';
            toggleGradeStatistics.href = 'javascript:void(0);';
            toggleGradeStatistics.id = 'toggle_grade_statistics';
            toggleGradeStatistics.textContent = 'Hide class statistics'; // Assumes that statistics are shown by default
            toggleGradeStatistics.addEventListener('click', () => gradeStatisticsDisplay(true));
            grade.insertAdjacentElement('afterend', toggleGradeStatistics);
          }
          gradeStatisticsDisplay(false);
        } else if (grade.nodeName === 'TR') {
          // Set table grade display
          const gradeCell = grade.querySelector('span.tooltip span');
          gradeCell.textContent = gradesArr[0].grade === 'NG' ? 'N/A' : `${gradesArr[0].grade}% (${gradesArr[0].letterGrade})`;
          // Remove the "grade" class so that Canvas cannot interact with the grade display
          gradeCell.classList.remove('grade');
          // Update points display
          if (window.coursePoints !== null) {
            // const groupScore = (+map[groupName].score.toLocaleString('en-US')).toFixed(2);
            grade.querySelector('span.possible.points_possible').textContent = `${(+window.coursePoints[0].toLocaleString('en-US')).toFixed(2)} / ${(+window.coursePoints[1].toLocaleString('en-US')).toFixed(2)}`;
          }
        }
      });
    }
    
    const popup = document.createElement('div');
    const overlay = document.createElement('div');
    const content = document.createElement('div');
    const closeButton = document.createElement('span');
    const popupTitle = document.createElement('h2');
    const popupSubtitle = document.createElement('h3');
    const popupContainer = document.createElement('div');
    const desiredGradeContainer = document.createElement('div');
    const desiredGradeTitle = document.createElement('h5');
    const desiredGradeInput = document.createElement('input');
    const desiredGradeErrorMessage = document.createElement('p');
    const desiredGradeWarningMessage = document.createElement('p')
    const minGradeContainer = document.createElement('div');
    const minGradeTitle = document.createElement('h5');
    const minGradeScore = document.createElement('span');
    const minGradeDivider = document.createElement('span');
    const minGradePercentage = document.createElement('span');
    const calculateButton = document.createElement('button');

    popup.classList.add('popup-canvas-grades-pro');
    overlay.classList.add('overlay');
    content.classList.add('content');
    closeButton.classList.add('close-btn');
    closeButton.innerHTML = '&times';
    popupTitle.textContent = 'What Grade Do I Need?';
    popupSubtitle.textContent = '\u200b';
    popupContainer.classList.add('container-canvas-grades-pro');
    desiredGradeContainer.id = 'desired-grade';
    desiredGradeTitle.textContent = 'Desired Grade';
    desiredGradeInput.type = 'text';
    desiredGradeInput.placeholder = '0-100 OR letter grade';
    desiredGradeInput.spellcheck = false;
    desiredGradeInput.autocomplete = false;
    desiredGradeInput.maxLength = 6;
    desiredGradeErrorMessage.id = 'popup-error-message';
    desiredGradeWarningMessage.id = 'popup-warning-message';
    minGradeContainer.id = 'minimum-grade';
    minGradeContainer.classList.add('hide-grades');
    minGradeTitle.textContent = 'Minimum Grade Required';
    minGradeScore.id = 'minimum-grade-score';
    minGradeDivider.id = 'minimum-grade-divider';
    minGradeDivider.innerHTML = '&#8596;';
    minGradePercentage.id = 'minimum-grade-percentage';
    calculateButton.id = 'popup-save-changes';
    calculateButton.textContent = 'Calculate!';

    desiredGradeContainer.appendChild(desiredGradeTitle);
    desiredGradeContainer.appendChild(desiredGradeInput);
    desiredGradeContainer.appendChild(desiredGradeErrorMessage);
    desiredGradeContainer.appendChild(desiredGradeWarningMessage);
    minGradeContainer.appendChild(minGradeTitle);
    minGradeContainer.appendChild(minGradeScore);
    minGradeContainer.appendChild(minGradeDivider);
    minGradeContainer.appendChild(minGradePercentage);
    popupContainer.appendChild(desiredGradeContainer);
    popupContainer.appendChild(minGradeContainer);
    content.appendChild(closeButton);
    content.appendChild(popupTitle);
    content.appendChild(popupSubtitle);
    content.appendChild(popupContainer);
    content.appendChild(calculateButton);
    popup.appendChild(overlay);
    popup.appendChild(content);
    document.body.appendChild(popup);

    const togglePopup = async function(event) {
      // Hide the minimum grade required result
      minGradeContainer.classList.add('hide-grades');
      // Clear the input for the minimum grade desired
      desiredGradeInput.value = '';
      popupSubtitle.textContent = '\u200b';
      desiredGradeErrorMessage.style.display = 'none';
      desiredGradeWarningMessage.style.display = 'none';
      popup.classList.toggle('active');
      if (!popup.classList.contains('active')) {
        window.minGradeAssignment = null;
        window.minGradeAssignmentName = null;
        return;
      }
      let elm = event.target;
      while (elm !== null && elm.tagName !== 'TR') {
        elm = elm.parentElement;
      }
      // Save the ID of the assignment that is being used for the "min grade" operation
      window.minGradeAssignment = +RegExp(/\d+/).exec(elm.id)[0];
      // Collect and store information about the "min grade" assignment: [assignment_name, assignment_group_id, assignment_point_total]
      const assignment = (await (await fetch(`/api/v1/courses/${courseID}/assignments/${window.minGradeAssignment}`)).json());
      window.minGradeAssignmentData = [assignment.name.trim(), assignment.assignment_group_id, assignment.points_possible];
      window.minGradeAssignmentName = window.minGradeAssignmentData[0];
      popupSubtitle.textContent = window.minGradeAssignmentName;
    }

    closeButton.addEventListener('click', togglePopup);
    window.addEventListener('keydown', event => {
      if (popup.classList.contains('active') && event.key === 'Escape') {
        popup.classList.remove('active');
      } 
    });

    const updateMinGradeDisplay = function(score, total) {
      if (total === undefined) {
        minGradePercentage.style.display = 'none';
        minGradeDivider.style.display = 'none';
      } else {
        minGradePercentage.style.display = '';
        minGradeDivider.style.display = '';
      }
      minGradeContainer.classList.remove('hide-grades');
      minGradeScore.textContent = total === undefined ? `Impossible! 😭` : `${+(score.toFixed(2))}/${total}`;
      minGradePercentage.textContent = total === undefined ? '' : (total === 0 ? '0%' : +((100 * score) / total).toFixed(2)+'%');
    }
    // Function for calculating the minimum grade required in order to get a certain grade in a course (or inform the user if their goal is impossible)
    const calculateMinGrade = async function() {
      minGradeContainer.classList.add('hide-grades');
      const gradeInput = document.getElementById('desired-grade').querySelector('input').value.replace(/\s/g, '');
      // If the desired grade is provided as a percentage, then use that, or else, try to parse the input as a letter grade and convert it to a percentage (if possible)
      const desiredGrade = +(/^((\d+(\.(\d+)?)?)|(\.\d+))%?$/.test(gradeInput) ? gradeInput.replace(/%/, '') : Object.entries(config.grading_standard ?? classGradingStandard ?? globalConfig.default_grading_standard ?? default_grading_standard).find(([_grade,letterGrade]) => letterGrade === gradeInput)?.[0] ?? undefined);
      // If the grade input is "bad", then display the error message and do not continue
      if (isNaN(desiredGrade)) {
        desiredGradeErrorMessage.textContent = "Invalid percentage / letter grade!"
        desiredGradeErrorMessage.style.display = 'revert';
        return;
      }
      // If the grade percentage is negative, then inform the user and do not continue
      if (desiredGrade < 0) {
        desiredGradeErrorMessage.textContent = "Please use a non-negative grade!";
        desiredGradeErrorMessage.style.display = 'revert';
        return;
      }
      desiredGradeErrorMessage.style.display = 'none';
      try {
        // Store assignments and other data for each category
        const map = {}; 
        // Store the group id, score, total, and other necessary information for the "min grade" operation (the assignment ID is stored at window.minGradeAssignment)
        // TODO Adjust this array so that the score is not stored
        const minGradeArr = [null,null,null,null,null,null,null]; // [group_id, score, total, drops: null (no drops) OR {low_drops, high_drops}, group_weighting, group_name, set: never_drop]
        // Check if ungraded/missing assignments are included in the grade calculation process
        const gradedAssignmentsOnly = document.getElementById('only_consider_graded_assignments')?.checked ?? true;
        if (config.use_weighting === undefined) {
          // The course will use weighting if the course provides weighting or if the config has weighting
          config.use_weighting = course.apply_assignment_group_weights || !isObjectEmpty(config.weights);
        }
        // Check if the course is unweighted
        const is_course_unweighted = !config.use_weighting;
        // Update the group id and the assignment point total for the "min grade" assignment
        minGradeArr[0] = window.minGradeAssignmentData[1];
        minGradeArr[2] = window.minGradeAssignmentData[2];
        // Calculate grades for each assignment group and store them in the map
        for (const group of courseAssignments) {
          let groupScore = 0;
          let groupTotal = 0;
          map[group.name] = {};
          map[group.name].weight = is_course_unweighted ? 1 : (!isObjectEmpty(config.weights) ? config.weights[group.name] : group.group_weight);
          // If we are on the "min grade" group and if this group has no weighting, then exit early (group has no impact on your grade so a 0 is the minimum) 
          if (group.id === minGradeArr[0] && map[group.name].weight === 0) {
            desiredGradeWarningMessage.style.display = 'revert';
            desiredGradeWarningMessage.textContent = '⚠️ Warning: ⚠️\nAssignment group has 0 weight';
            window.courseGrades[0] >= desiredGrade ? updateMinGradeDisplay(0, minGradeArr[2]) : updateMinGradeDisplay();
            return;
          } else if (group.id === minGradeArr[0]) {
            desiredGradeWarningMessage.style.display = 'none';
          }
          map[group.name].grades = new Array();
          for (const assignment of group.assignments) {
            // Do not include assignments that are not counted towards your final grade (also don't include assignments that have not been graded)
            // Don't consider missing/ungraded assignments if the gradedAssignmentsOnly checkbox is ticked or if there is a what-if score
            // Assignment is missing if assignment.submission.missing is true; Assignment is ungraded if assignment.submission.score is null or if assignment.submission.workflow_state is not "graded"
            // Do not skip the current assignment if it is the "min grade" assignment
            const missingFlag = assignment.submission.missing;
            const ungradedFlag = assignment.submission.score === null|| assignment.submission.workflow_state !== 'graded';
            if (window.minGradeAssignment !== assignment.id && (assignment.omit_from_final_grade || (gradedAssignmentsOnly && ((missingFlag || ungradedFlag) && window.previousGradeConfig !== 'DOM' && window.previousGradeConfig?.[assignment.id] === undefined)))) {
              continue;
            }
            // Check if the current assignment is the current assignment for the "min grade" operation
            if (window.minGradeAssignment === assignment.id) {
              minGradeArr[1] = assignment.submission.score ?? null;
              minGradeArr[4] = map[group.name].weight;
              minGradeArr[5] = group.name;
              continue;
            }
            const total = assignment.points_possible;
            if (total === null) {
              continue;
            }
            const score = window.previousGradeConfig === 'DOM' ? getWhatIfGrade(assignment) : window.previousGradeConfig?.[assignment.id] ?? assignment.submission.score ?? 0;
            if (score === null || score === undefined) {
              continue;
            }
            map[group.name].grades.push({
              id: assignment.id,
              score,
              total,
            });
            groupScore += score;
            groupTotal += total;
          }
          // Update map with computed values for the current group
          map[group.name].score = groupScore;
          map[group.name].total = groupTotal;
          map[group.name].decimal = groupTotal === 0 ? 0 : groupScore / groupTotal;
        }
        // Attempt to perform drops here
        for (const group of courseAssignments) {
          const totalAssignments = map[group.name].grades.length;
          // Check if the number of drops is illegal (>= total assignments) and make adjustments accordingly
          const [lowDrops, highDrops] = validateDropCounts(config.drops?.[group.name]?.[0] ?? group.rules.drop_lowest ?? 0, config.drops?.[group.name]?.[1] ?? group.rules.drop_highest ?? 0, totalAssignments);
          // If there are no drops to be done, then no further processing is necessary
          if (lowDrops === 0 && highDrops === 0) {
            continue;
          }
          // Check if the group for the "min grade" uses drops (only reaches this point if the current group has at least one low / high drop)
          if (group.id === minGradeArr[0]) {
            // Set the drops used flag to true and DO NOT perform any processing on this group
            minGradeArr[3] = [lowDrops, highDrops];
            // Configure the never drop set
            minGradeArr[6] = new Set(group.rules.never_drop ?? []);
            continue;
          }
          // Sort the assignments by simulating the grade after dropping the current assignment (higher grade after drop is placed earlier)
          map[group.name].grades.sort((a,b) => {
            const dec_a = (map[group.name].score - a.score) / (map[group.name].total - a.total);
            const dec_b = (map[group.name].score - b.score) / (map[group.name].total - b.total);
            return dec_b - dec_a;
          });
          // Create a set of the assignments that should not be dropped
          const neverDrop = new Set(group.rules.never_drop ?? []);
          // Perform the low drops
          for (let i = 0; i < lowDrops; i++) {
            if (totalAssignments === 0) {
              break;
            }
            const assignment = map[group.name].grades[0];
            // If the current assignment should not be dropped, then move it to a special array then skip the additional processing
            if (neverDrop.has(assignment.id)) {
              map[group.name].grades.shift();
              // Decrement i since the current assignment is not actually being dropped
              i--;
              continue;
            }
            map[group.name].score -= assignment.score;
            map[group.name].total -= assignment.total;
            // Remove elements from grades array
            map[group.name].grades.shift();
          }
          // Perform the high drops
          for (let i = 0; i < highDrops; i++) {
            if (totalAssignments === 0) {
              break;
            }
            const assignment = map[group.name].grades[totalAssignments-1];
            // If the current assignment should not be dropped, then move it to a special array then skip the additional processing
            if (neverDrop.has(assignment.id)) {
              map[group.name].grades.pop();
              // Decrement i since the current assignment is not actually being dropped
              i--;
              continue;
            }
            map[group.name].score -= assignment.score;
            map[group.name].total -= assignment.total;
            map[group.name].grades.pop();
          }
          // Re-calculate the decimal for the current group after applying drops
          map[group.name].decimal = map[group.name].total === 0 ? 0 : Math.round((1e4 * map[group.name].score) / map[group.name].total) / 1e4;
        }

        // Get the minimum grade needed for the current group to obtain the desired group in the current course
        const getMinGroupGrade = function() {
          if (is_course_unweighted) {
            return null;
          }
          // Course is weighted
          let classScore = 0;
          let weightTotal = 0;
          for (const group of courseAssignments) {
            // Add the weight for the current group to the total (and do nothing else) if the current group has the "min grade" 
            // This case is necessary since the "min grade" is not considered when computing a group's total (map[group.name].total)
            if (group.id === minGradeArr[0]) {
              weightTotal += map[group.name].weight;
              continue;
            }
            // If there are no grades available in this group, then don't process this group
            if (map[group.name].total === 0) {
              continue;
            }
            // Compute the class score while considering weighting
            classScore += (map[group.name].score * map[group.name].weight / map[group.name].total);
            // Keep track of the total weight being used for your grade
            weightTotal += map[group.name].weight;
          }
          const k = weightTotal === 0 ? 0 : 100 / weightTotal;
          // Throw an error if unexpected behavior arises
          if (k === 0) {
            throw new Error(`Something unexpected happened when attempting to calculate the minimum grade required on assignment ${window.minGradeAssignment} to get a ${desiredGrade}`);
          }
          // Scale the weighting for the "min grade" group
          minGradeArr[4] *= k;
          // Scale the class score using the total considered weighting
          classScore *= k;
          // Find the maximum grade (percentage) that you can get without including the "min grade" group
          const maxGrade = 100 - minGradeArr[4];
          // Throw an error if unexpected behavior arises
          if (maxGrade === 100) {
            throw new Error(`Something unexpected happened when attempting to calculate the minimum grade required on assignment ${window.minGradeAssignment} to get a ${desiredGrade}`, maxGrade);
          }
          // Find the minimum group grade required to get your desired grade in the class (cannot be less than 0)
          return Math.max(desiredGrade - classScore, 0) / (100 - maxGrade);
        }
        // Check if drops were used for the current group, and if so, then perform the correct operation for finding the "min grade"
        if (minGradeArr[3] != null) {
          // Sort the min grades array
          map[minGradeArr[5]].grades.sort((a,b) => {
            const dec_a = (map[minGradeArr[5]].score - a.score) / (map[minGradeArr[5]].total - a.total);
            const dec_b = (map[minGradeArr[5]].score - b.score) / (map[minGradeArr[5]].total - b.total);
            return dec_b - dec_a;
          });
          const gradesArr = map[minGradeArr[5]].grades;
          // Remove all assignments that are "never dropped" from the grades array (makes processing much easier)
          // Removal of the assignments in being done in place
          if (minGradeArr[6].size !== 0) {
            let marker = 0;
            for (let i = 0; i < gradesArr.length; i++) {
              const grade = gradesArr[i];
              if (minGradeArr[6].has(grade.id)) {
                gradesArr[i] = null;
              } else {
                gradesArr[marker++] = gradesArr[i];
              }
            }
            gradesArr.length = marker;
          }
          // If the course is unweighted, then calculate the complete score and complete total (without the current group)
          const nonMinGroupGrade = !is_course_unweighted ? null : (function() {
            let completeScore = 0;
            let completeTotal = 0;
            for (const group of courseAssignments) {
              if (group.id === minGradeArr[0]) {
                continue;
              }
              completeScore += map[group.name].score;
              completeTotal += map[group.name].total;
            }
            return [completeScore, completeTotal];
          })();
          let activeScore = map[minGradeArr[5]].score;
          let activeTotal = map[minGradeArr[5]].total;
          //
          // Check if the current assignment is not a never drop assignment
          const canMinGradeDrop = !minGradeArr[6].has(window.minGradeAssignment);
          // minGradeArr[3]: [low_drops, high_drops]
          // group score: map[minGradeArr[5]].score
          // group total: map[minGradeArr[5]].total
          const minGroupGrade = getMinGroupGrade();
          if (minGradeArr[3][0] + minGradeArr[3][1] >= gradesArr.length + 1) {
            // All of the assignments are dropped (the never drop assignments will not be in the grades array so just subtract all of the scores & totals)
            for (const assignment of gradesArr) {
              activeScore -= assignment.score;
              activeTotal -= assignment.total;
            }
            // The "min grade" does not matter here, since the current assignment is being dropped
            updateMinGradeDisplay(0, minGradeArr[2]);
            return;
          }
          // Subtract initial low drop score/total points (off by one since the "min grade" will be placed at the beginning of the grades array)
          for (let i = 0; i < minGradeArr[3][0] - 1; i++) {
            activeScore -= gradesArr[i].score;
            activeTotal -= gradesArr[i].total;
          }
          // Subtract high drops score/total points
          for (let i = 0; i < minGradeArr[3][1]; i++) {
            activeScore -= gradesArr[gradesArr.length-1-i].score;
            activeTotal -= gradesArr[gradesArr.length-1-i].total;
          }

          // Note the proper starting and ending boundaries [startIdx, finishIdx)
          const startIdx = Math.max(0, minGradeArr[3][0] - 1);
          const finishIdx = gradesArr.length - minGradeArr[3][1];

          // TODO Change this since iterating through the entire window is not actually necessary (the assignment is either a low drop, a high drop, or normal) [only a max of 3 cases for the "min grade"]
          for (let i = startIdx; i < finishIdx; i++) {
            // Check if the "min grade" assignment should be considered as a low drop (in terms of the active score and total)
            // Also check if the "min grade" assignment should be considered as a high drop
            if ((i === startIdx && minGradeArr[3][0] > 0 && !canMinGradeDrop) || (i === startIdx + 1 && minGradeArr[3][0] > 0 && canMinGradeDrop)) {
              activeScore -= gradesArr[i-1].score;
              activeTotal -= gradesArr[i-1].total;
            } else if (i === finishIdx - 1 && minGradeArr[3][1] > 0 && canMinGradeDrop) {
              activeScore += gradesArr[i+1].score;
              activeTotal += gradesArr[i+1].total;
            }
            // Set a flag for whether or not the current assignment is being considered as a drop
            const dropFlag = canMinGradeDrop && ((i === startIdx && minGradeArr[3][0] > 0) || (i === finishIdx - 1 && minGradeArr[3][1] > 0));
            const maxScore = i === finishIdx - 1 && minGradeArr[3][1] === 0 ? Infinity : (dropFlag ? 0 : (activeScore - (activeTotal - gradesArr[i].total) * (activeScore - gradesArr[i].score) / (activeTotal - gradesArr[i].total)));
            const maxGrade = i === finishIdx - 1 && minGradeArr[3][1] === 0 ? Infinity : (dropFlag ? 100 * activeScore / activeTotal : (100 * (activeScore + maxScore) / (activeTotal + minGradeArr[2])));
            // Check if the max score gives you the desired grade (if not then check if the max grade is greater than the desired grade)
            if (!is_course_unweighted && maxGrade >= 100 * minGroupGrade) {
              // We can safely use a grade less than or equal to the max grade to get the desired grade
              const minGrade = maxScore === 0 ? 0 : Math.max(0, (activeTotal + minGradeArr[2]) * minGroupGrade - activeScore);
              updateMinGradeDisplay(minGrade, minGradeArr[2]);
              return;
            } else if (is_course_unweighted && (100 * (maxScore + activeScore + nonMinGroupGrade[0]) / ((dropFlag ? 0 : minGradeArr[2]) + activeTotal + nonMinGroupGrade[1])) >= desiredGrade) {
              // We can safely use a grade less than or equal to the max grade to get the desired grade
              // Account for whether or not the "min grade" assignment is being dropped for the first iteration (use the drop flag)
              const minGrade = Math.max(0, ((dropFlag ? 0 : minGradeArr[2]) + activeTotal + nonMinGroupGrade[1]) * (desiredGrade / 100) - (activeScore + nonMinGroupGrade[0]))
              updateMinGradeDisplay(minGrade, minGradeArr[2]);
              return;
            }
          }
          // The "min grade" is a high drop (since a valid grade wasn't caught in the loop, the desired grade cannot be obtained)
          updateMinGradeDisplay();
          return;
        }
        // Drops were not used for the current group (easy case)
        // Check if the course is unweighted
        if (is_course_unweighted) {
          let completeScore = 0;
          let completeTotal = 0;
          for (const group of courseAssignments) {
            // Compute score and total for your grade
            completeScore += map[group.name].score;
            completeTotal += map[group.name].total;
          }
          // Solve for the min grade (set the lower bond)
          const minGrade = Math.max(0, (completeTotal + minGradeArr[2]) * (desiredGrade / 100) - completeScore);
          updateMinGradeDisplay(minGrade, minGradeArr[2]);
          return;
        }
        const minGroupGrade = getMinGroupGrade();
        // Solve for the min grade
        const minGrade = Math.max(0, (map[minGradeArr[5]].total + minGradeArr[2]) * minGroupGrade - map[minGradeArr[5]].score);
        updateMinGradeDisplay(minGrade, minGradeArr[2]);
      } catch (err) {
        console.error(`An error has occured when calculating the course grade for ${course.course_code}`, err);
      }
    }
    // Create elements to be cloned into each of the rows retrieved by the selector below
    const minScoreButton = document.createElement('button');
    const minScoreIcon = document.createElement('i');
    minScoreIcon.classList.add('fas', 'fa-calculator');
    minScoreButton.style.background = 'none';
    minScoreButton.style.border = 'none';
    minScoreButton.style.outline = 'none';
    minScoreButton.style.fontSize = '1.2em';
    minScoreButton.style.position = 'absolute';
    minScoreButton.style.transform = 'translate(-530%, 20%)';
    minScoreButton.appendChild(minScoreIcon);
    // Apply the mutation observer to all of the assignment grade cells and add min grade buttons
    const assignmentGradeCells = document.getElementById('grades_summary').querySelectorAll('tbody tr:not(.hard_coded) span.grade');
    for (const gradeCell of assignmentGradeCells) {
      const cell = gradeCell.parentElement.parentElement.parentElement.nextElementSibling;
      const minScoreElm = minScoreButton.cloneNode(true);
      minScoreElm.addEventListener('click', togglePopup);
      cell.appendChild(minScoreElm);
      observer.observe(gradeCell, {
        childList: true
      });
    }
    if (assignmentGradeCells.length !== 0) {
      const detailsHeaderText = document.createElement('p');
      detailsHeaderText.innerHTML = 'Min Score for Desired Grade';
      detailsHeaderText.style.fontSize = '.7em';
      detailsHeaderText.style.fontWeight = 550;
      detailsHeaderText.style.marginLeft = '2.4em';
      detailsHeaderText.style.textAlign = 'center';
      detailsHeaderText.style.width = '7em';
      detailsHeaderText.style.transform = 'translateX(-90%)';
      document.getElementById('grades_summary').querySelector('thead .assignment_score').nextElementSibling.appendChild(detailsHeaderText);
    }
    calculateButton.addEventListener('click', calculateMinGrade);
    desiredGradeInput.addEventListener('keydown', event => {
      if (event.key === 'Enter') {
        calculateMinGrade();
      }
    });
    // Set the grade display initially (when the course page loads in)
    await updateGradeDisplay(null, window.previousGradeConfig);
  });
}
// TODO Confirm that this is working properly and that there are no errors / failure cases
// Calculate the percentile that your grade lies in (this is an approximate value and will not be entirely correct due to the lack of data)
const calculatePercentile = function(q1, q2, q3, grade, low, high) {
  let percentile;
    // If all of the bounds are equal, then everyone has the same grade (which means that you are in the highest percentile)
  if (q1 === low && q1 === q2 && q2 === q3 && q3 === high) {
    return 99.99
  }
  // Manually check each of the bounds in decrementing order (to catch cases of the class statistics being equal)
  if (grade === high) {
    return 99.99;
  }
  if (grade === q3) {
    return 75;
  }
  if (grade === q2) {
    return 50;
  }
  if (grade === q1) {
    return 25;
  }
  if (grade === low) {
    return 0.01;
  }
  if (grade <= q1) {
    percentile = ((grade - low) / (q1 - low)) * 25;
  } else if (grade <= q2) {
    percentile = 25 + ((grade - q1) / (q2 - q1)) * 25;
  } else if (grade <= q3) {
    percentile = 50 + ((grade - q2) / (q3 - q2)) * 25;
  } else {
    percentile = 75 + ((grade - q3) / (high - q3)) * 25;
  }
  // Round the percentile to two decimal places before returning
  // Also bound sthe percentile in the following range: [0.01, 0.99]
  return Math.max(0.01, Math.min(99.99, Math.round(100 * percentile) / 100));
}

/**
 * If any config is set, then the grade is calculated manually
 * if their is no weighting, then the grade is calculated manually
 * whatIfScores: null / Dictionary / "DOM"
 * getCourseStats: boolean (determining whether or not the course statistic grades will be calculated)
 */
const getCourseGrade = async function(course, config, groups, whatIfScores, getCourseStatistics) {
  if (course.workflow_state === 'unpublished' || course.workflow_state === 'completed') {
    return ['NG'].concat(new Array(6).fill(-1));
  }
  // If the assignment groups have not been provided, then fetch them and update the groups variable
  if (groups === null) {
    groups = [];
    let assignmentsPage = 1;
    while (true) {
      const response = await fetch(`/api/v1/courses/${course.id}/assignment_groups?per_page=100&include[]=assignments&include[]=score_statistics&include[]=overrides&include[]=submission&page=${assignmentsPage}`);
      const assignments = await response.json();
      if (assignments.length === 0) {
        break;
      }
      for (const assignment of assignments) {
        groups.push(assignment);
      }
      assignmentsPage++;
    }
  }
  try {
    // Check if ungraded/missing assignments are included in the grade calculation process
    const gradedAssignmentsOnly = document.getElementById('only_consider_graded_assignments')?.checked ?? true;
    // Store assignments and other data for each category
    const map = {}; 
    // Store mapping from group id to group name
    const groupMap = {};
    // Check if config weighting is valid
    const validWeighting = !isObjectEmpty(config.weights) && (function() {
      const weightValues = Object.values(config.weights);
      return weightValues.length === groups.length && weightValues.every(weight => weight !== undefined && weight !== null);
    })();
    if (config.use_weighting === undefined) {
      // The course will use weighting if the course provides weighting or if the config has weighting
      // Weighting will be invalidated if assignment groups are invalidated
      config.use_weighting = course.apply_assignment_group_weights || validWeighting;
    }
    // Check if the course is unweighted
    const is_course_unweighted = !config.use_weighting;
    // Calculate statistics and grades for each assignment group and store them in the map
    for (const group of groups) {
      let groupScore = 0;
      let groupTotal = 0;
      let statsGroupTotal = 0;
      map[group.name] = {};
      groupMap[group.id] = group.name;
      map[group.name].weight = is_course_unweighted ? 1 : (validWeighting ? config.weights[group.name] : group.group_weight);
      map[group.name].grades = new Array();
      if (getCourseStatistics) {
        map[group.name].q1 = {};
        map[group.name].q1.score = 0;
        map[group.name].q1.grades = new Array();
        map[group.name].q2 = {}; // q2 = median
        map[group.name].q2.score = 0;
        map[group.name].q2.grades = new Array();
        map[group.name].q3 = {};
        map[group.name].q3.score = 0;
        map[group.name].q3.grades = new Array();
        map[group.name].mean = {};
        map[group.name].mean.score = 0;
        map[group.name].mean.grades = new Array();
        map[group.name].low = {};
        map[group.name].low.score = 0;
        map[group.name].low.grades = new Array();
        map[group.name].high = {};
        map[group.name].high.score = 0;
        map[group.name].high.grades = new Array();
      }
      for (const assignment of group.assignments) {
        // Do not include assignments that are not counted towards your final grade (also don't include assignments that have not been graded)
        // Don't consider missing/ungraded assignments if the gradedAssignmentsOnly checkbox is ticked or if there isn't a what-if score
        // Assignment is missing if assignment.submission.missing is true; Assignment is ungraded if assignment.submission.score is null or if assignment.submission.workflow_state is not "graded"
        const missingFlag = assignment.submission.missing;
        const ungradedFlag = assignment.submission.score === null || assignment.submission.workflow_state !== 'graded';
        if (assignment.omit_from_final_grade || (gradedAssignmentsOnly && ((missingFlag || ungradedFlag) && whatIfScores !== 'DOM' && whatIfScores?.[assignment.id] === undefined))) {
          continue;
        }
        const statistics = assignment.score_statistics;
        const total = assignment.points_possible;
        if (total === null) {
          continue;
        }
        // Use What-If score if there is one available
        const score = whatIfScores === 'DOM' ? getWhatIfGrade(assignment) : whatIfScores?.[assignment.id] ?? assignment.submission.score ?? (!gradedAssignmentsOnly ? 0 : null);
        // Skip this assignment if the score is null
        if (score === null || score === undefined) {
          continue;
        }
        map[group.name].grades.push({
          id: assignment.id,
          score,
          total,
        });
        if (getCourseStatistics && statistics !== undefined) {
          // Add grade to the list of grades for each stat
          map[group.name].q1.grades.push({
            score: statistics.lower_q,
            total,
          });
          map[group.name].q2.grades.push({
            score: statistics.median,
            total,
          });
          map[group.name].q3.grades.push({
            score: statistics.upper_q,
            total,
          });
          map[group.name].mean.grades.push({
            score: statistics.mean,
            total,
          });
          map[group.name].low.grades.push({
            score: statistics.min,
            total,
          });
          map[group.name].high.grades.push({
            score: statistics.max,
            total,
          });
          // Contribute to the score total of all of the grades for each stat
          map[group.name].q1.score += statistics.lower_q;
          map[group.name].q2.score += statistics.median;
          map[group.name].q3.score += statistics.upper_q;
          map[group.name].mean.score += statistics.mean;
          map[group.name].low.score += statistics.min;
          map[group.name].high.score += statistics.max;
          statsGroupTotal += total;
        }
        groupScore += score;
        groupTotal += total;
      }
      // Update map with computed values for the current group
      map[group.name].score = groupScore;
      map[group.name].total = groupTotal;
      map[group.name].decimal = groupTotal === 0 ? 0 : groupScore / groupTotal;
      if (getCourseStatistics) {
        map[group.name].statsTotal = statsGroupTotal;
        map[group.name].q1.total = statsGroupTotal;
        map[group.name].q2.total = statsGroupTotal;
        map[group.name].q3.total = statsGroupTotal;
        map[group.name].mean.total = statsGroupTotal;
        map[group.name].low.total = statsGroupTotal;
        map[group.name].high.total = statsGroupTotal;
        map[group.name].q1.decimal = statsGroupTotal === 0 ? 0 : map[group.name].q1.score / statsGroupTotal;
        map[group.name].q2.decimal = statsGroupTotal === 0 ? 0 : map[group.name].q2.score / statsGroupTotal;
        map[group.name].q3.decimal = statsGroupTotal === 0 ? 0 : map[group.name].q3.score / statsGroupTotal;
        map[group.name].mean.decimal = statsGroupTotal === 0 ? 0 : map[group.name].mean.score / statsGroupTotal;
        map[group.name].low.decimal = statsGroupTotal === 0 ? 0 : map[group.name].low.score / statsGroupTotal;
        map[group.name].high.decimal = statsGroupTotal === 0 ? 0 : map[group.name].high.score / statsGroupTotal;
      }
    }
    // Remove 'dropped' class from all rows that currently have it (re-apply the 'dropped' class manually)
    document.querySelectorAll('#grades_summary .dropped').forEach(assignment => assignment.classList.remove('dropped'));
    // Attempt to perform drops here (also update UI for dropped assignments)
    for (const group of groups) {
      const totalAssignments = map[group.name].grades.length;
      // Check if the number of drops is illegal (>= total assignments) and make adjustments accordingly
      const [lowDrops, highDrops] = validateDropCounts(config.drops?.[group.name]?.[0] ?? group.rules.drop_lowest ?? 0, config.drops?.[group.name]?.[1] ?? group.rules.drop_highest ?? 0, totalAssignments);
      // If there are no drops to be done, then no further processing is necessary
      if (lowDrops === 0 && highDrops === 0) {
        continue;
      }
      // Sort the assignments by simulating the grade after dropping the current assignment (higher grade after drop is placed earlier)
      map[group.name].grades.sort((a,b) => {
        const dec_a = (map[group.name].score - a.score) / (map[group.name].total - a.total);
        const dec_b = (map[group.name].score - b.score) / (map[group.name].total - b.total);
        return dec_b - dec_a;
      });
      // Create a set of the assignments that should not be dropped
      const neverDrop = new Set(group.rules.never_drop ?? []);
      // Perform the low drops
      for (let i = 0; i < lowDrops; i++) {
        if (totalAssignments === 0) {
          break;
        }
        const assignment = map[group.name].grades[0];
        // If the current assignment should not be dropped, then move it to a special array then skip the additional processing
        if (neverDrop.has(assignment.id)) {
          map[group.name].grades.shift();
          // Decrement i since the current assignment is not actually being dropped
          i--;
          continue;
        }
        // Decrease the score and total properties
        map[group.name].score -= assignment.score;
        map[group.name].total -= assignment.total;
        // Remove elements from grades array
        map[group.name].grades.shift();
        // Apply dropped UI by adding the 'dropped' class to the assignment row that is being dropped (uses assignment ID)
        if (document.title !== 'Dashboard') {
          document.getElementById(`submission_${assignment.id}`).classList.add('dropped');
        }
      }
      // Perform the high drops
      for (let i = 0; i < highDrops; i++) {
        if (totalAssignments === 0) {
          break;
        }
        const assignment = map[group.name].grades[totalAssignments-1];
        // If the current assignment should not be dropped, then move it to a special array then skip the additional processing
        if (neverDrop.has(assignment.id)) {
          map[group.name].grades.pop();
          // Decrement i since the current assignment is not actually being dropped
          i--;
          continue;
        }
        map[group.name].score -= assignment.score;
        map[group.name].total -= assignment.total;
        map[group.name].grades.pop();
        // Apply dropped UI by adding the 'dropped' class to the assignment row that is being dropped (uses assignment ID)
        if (document.title !== 'Dashboard') {
          document.getElementById(`submission_${assignment.id}`).classList.add('dropped');
        }
      }
      // Re-calculate the decimal for the current group after applying drops
      map[group.name].decimal = map[group.name].total === 0 ? 0 : Math.round((1e4 * map[group.name].score) / map[group.name].total) / 1e4;
    }
    // Update group total rows at the bottom of the table
    const groupTotals = document.querySelectorAll('.group_total');
    for (const row of groupTotals) {
      const groupID = RegExp(/\d+/).exec(row.id)[0];
      const groupName = groupMap[groupID];
      const groupScore = groupName === undefined ? '0.00' : (+map[groupName].score.toLocaleString('en-US')).toFixed(2);
      const groupTotal = groupName === undefined ? '0.00' : (+map[groupName].total.toLocaleString('en-US')).toFixed(2);
      const groupPercentage = groupName === undefined ? 0 : Math.round(1e4 * map[groupName].decimal) / 1e2;
      // Change the text while also removing the child of these elements, thus severing cell from any Canvas-enforced updates
      row.querySelector('span.tooltip').textContent = groupTotal === '0.00' ? 'N/A' : groupPercentage + '%';
      row.querySelector('td.details').textContent = `${groupScore} / ${groupTotal}`;
    }
    let completeScore = 0;
    let completeTotal = 0;
    // If the course is unweighted, then compute the grade (and statistics grades too if applicable)
    if (is_course_unweighted) {
    const stats = { q1: [0,0], q2: [0,0], q3: [0,0], mean: [0,0], low: [0,0], high: [0,0] };
      for (const group of groups) {
        // Compute score and total for your grade
        completeScore += map[group.name].score;
        completeTotal += map[group.name].total;
        // If the statsTotal is 0 or if we are not calculating the course statistics, then finish computing the current group
        if (!getCourseStatistics || map[group.name].statsTotal === 0) {
          continue;
        }
        // Compute the score and total for the class statistics
        stats.q1[0] += map[group.name].q1.score;
        stats.q2[0] += map[group.name].q2.score;
        stats.q3[0] += map[group.name].q3.score;
        stats.mean[0] += map[group.name].mean.score;
        stats.low[0] += map[group.name].low.score;
        stats.high[0] += map[group.name].high.score;
        stats.q1[1] += map[group.name].q1.total;
        stats.q2[1] += map[group.name].q2.total;
        stats.q3[1] += map[group.name].q3.total;
        stats.mean[1] += map[group.name].mean.total;
        stats.low[1] += map[group.name].low.total;
        stats.high[1] += map[group.name].high.total;
      }
      window.coursePoints = [completeScore, completeTotal];
      // If there are no grades contributing to the class statistics, then return -1 
      // Grades are all rounded to 2 decimal places 
      return [completeTotal === 0 ? 'NG' : +((100 * completeScore / completeTotal).toFixed(2))]
      .concat(stats.q1[1] === 0 ? new Array(6).fill(-1) : [
        +((100 * stats.q1[0] / stats.q1[1]).toFixed(2)),
        +((100 * stats.q2[0] / stats.q2[1]).toFixed(2)),
        +((100 * stats.q3[0] / stats.q3[1]).toFixed(2)),
        +((100 * stats.mean[0] / stats.mean[1]).toFixed(2)),
        +((100 * stats.low[0] / stats.low[1]).toFixed(2)),
        +((100 * stats.high[0] / stats.high[1]).toFixed(2))
      ]);
    }
    let classScore = 0;
    let weightTotal = 0;
    let statsWeightTotal = 0;
    const stats = { q1: 0, q2: 0, q3: 0, mean: 0, low: 0, high: 0 };
    for (const group of groups) {
      // If there are no grades available in this group, then don't process this group
      if (map[group.name].total === 0) {
        continue;
      }
      // Compute the class score while considering weighting
      classScore += (map[group.name].score * map[group.name].weight / map[group.name].total);
      // Keep track of the total weight being used for your grade
      weightTotal += map[group.name].weight;
        // If the statsTotal is 0, then don't continue to compute this group
      if (!getCourseStatistics || map[group.name].statsTotal === 0) {
        continue;
      }
      // Keep track of the total weight being used for the class statistics
      statsWeightTotal += map[group.name].weight;
      // Compute the grades for class statistics while considering weighting
      stats.q1 += (map[group.name].q1.score * map[group.name].weight / map[group.name].q1.total);
      stats.q2 += (map[group.name].q2.score * map[group.name].weight / map[group.name].q2.total);
      stats.q3 += (map[group.name].q3.score * map[group.name].weight / map[group.name].q3.total)
      stats.mean += (map[group.name].mean.score * map[group.name].weight / map[group.name].mean.total);
      stats.low += (map[group.name].low.score * map[group.name].weight / map[group.name].low.total);
      stats.high += (map[group.name].high.score * map[group.name].weight / map[group.name].high.total);
    }
    // Compute scalars for determining how to scale your grade and the class statistics grades 
    // Solves the issue of having assignment groups with 0 entries being stored as a 0
    const k = weightTotal === 0 ? 0 : 100 / weightTotal;
    const statsK = statsWeightTotal === 0 ? 0 : 100 / statsWeightTotal;
    // Grades are all rounded to 2 decimal places 
    return [k === 0 ? 'NG' : +((k * classScore).toFixed(2))]
    .concat(statsK === 0 ? new Array(6).fill(-1) : [
      +((statsK * stats.q1).toFixed(2)),
      +((statsK * stats.q2).toFixed(2)),
      +((statsK * stats.q3).toFixed(2)),
      +((statsK * stats.mean).toFixed(2)),
      +((statsK * stats.low).toFixed(2)),
      +((statsK * stats.high).toFixed(2))
    ]);
  } catch (err) {
    console.error(`An error has occured when calculating the course grade for ${course.course_code}`, err);
  } 
}

// Get the What-If using the DOM (check the current assignments score cell for the changed class)
const getWhatIfGrade = function (assignment) {
  const scoreCell = document.getElementById(`submission_${assignment.id}`).querySelector('span.grade');
  return scoreCell.classList.contains('changed') ? +scoreCell.firstChild.textContent.replace(/,/g, '') : assignment.submission.score;
}

// Return the letter grade for an associated grade, using a course's config to retrieve the grading standard
const getLetterGrade = async function(gradingStandard, grade) {
  // If there is no grade, then return null
  if (grade === 'NG') {
    return null;
  }
  if (grade < 0) {
    return 'N/A';
  }
  // Default grading scheme (sorted in descending order) [sorting is automatic?]
  const weights = Object.keys(gradingStandard).map(Number);
  // Sort the weights in ascending order
  weights.sort((a,b) => a-b);
  // Binary search on the weights
  let left = 0, right = weights.length - 1;
  while (left <= right) {
    const mid = Math.floor((left + right) / 2);
    const rightMid = weights[mid+1] ?? Infinity;
    if (grade >= weights[mid] && grade < rightMid) {
      return gradingStandard[weights[mid]];
    } else if (grade < weights[mid]) {
      right = mid - 1;
    } else {
      left = mid + 1;
    }
  }
  return 'N/A';
}

const retrieveGradingStandard = async function(courseID, gradingStandardID) {
  const grading_standard = (await (await fetch(`/api/v1/courses/${courseID}/grading_standards/${gradingStandardID}`)).json()).grading_scheme;
  // If the grading standard is not there, then return null (this can occur when the teacher has a grading standard, but you cannot view it)
  if (grading_standard === undefined) {
    return null;
  }
  const grading_standard_map = {};
  for (const {name,value} of grading_standard) {
    grading_standard_map[100*value] = name;
  }
  return grading_standard_map;
}