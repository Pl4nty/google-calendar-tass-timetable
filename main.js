'use strict';

//USER INPUT
let CALENDAR_ID = 'primary';//Email address of calendar to add events to, use 'primary' for user's default calendar
let START_DATE; //Date for classes to start
let END_DATE; //Date for classes to stop
const SCHOOL = 'Toowoomba Grammar School, East Toowoomba QLD 4350'; //Google Maps location of school
const TIME_ZONE = 'Australia/Brisbane'; //Timezone of school

const {google} = require('googleapis');
const CALLBACK_URL = 'http://localhost:8000/callback';

const oauth2Client = new google.auth.OAuth2(
	//credentials here
	CALLBACK_URL
);

// generate a url that asks permissions for Google+ and Google Calendar scopes
const url = oauth2Client.generateAuthUrl({
	// 'online' (default) or 'offline' (gets refresh_token)
	access_type: 'offline',

	// If you only need one scope you can pass it as a string
	scope: 'https://www.googleapis.com/auth/calendar'
});

const {app, BrowserWindow, dialog} = require('electron');
dialog.showErrorBox = (title, content) => {
	console.log(`${title}\n${content}`);
};
//require('electron-reload')(__dirname);

let win;
let loadedCalendar = false;

const createWindow = () => {
	win = new BrowserWindow({webPreferences: {nodeIntegration: false}, width: 600, height:800, show: false, useContentSize: true, title: "Add Student Cafe timetable to Google Calendar"});
	win.setMenu(null);

	win.on('page-title-updated', e => {
		e.preventDefault()
	});

	win.webContents.on('will-navigate',(event, newUrl) => {
		if (newUrl === 'https://localhost:8000/googleAuth') {
			win.webContents.executeJavaScript(`
					let dates = document.getElementsByClassName('date');
					[dates[0].value,dates[1].value];
				`, dates => {
				[START_DATE,END_DATE] = dates;
				win.loadURL(url);
			});
		}
		if (newUrl.startsWith(CALLBACK_URL)) {
			authenticate(newUrl);

			win.webContents.on('will-navigate',function(){});
		}
	});
	win.on('ready-to-show', () => win.show());


	win.webContents.on('did-frame-navigate', (event, url) => {
		if (loadedCalendar) return;
		switch (url) {
			case 'https://tass.twgs.qld.edu.au/StudentCafe/index.cfm': {
				console.log('Authenticated with Student Cafe');
				win.loadURL('https://tass.twgs.qld.edu.au/StudentCafe/index.cfm?do=studentportal.timetable.main.fullTimetable');

				break;
			}
			case 'https://tass.twgs.qld.edu.au/StudentCafe/index.cfm?do=studentportal.timetable.main.fullTimetable': {
				win.webContents.once('did-finish-load',() => {
					if (loadedCalendar) return;
					loadedCalendar = true;
					awaitTimetable();
				});
				break;
			}

			default: {}
		}
	});

	win.on('closed',()=>{
		win = null;
		app.quit();
	});

	win.loadFile('menu.html');
};

const authenticate = async newUrl => {
	const {tokens} = await oauth2Client.getToken(newUrl.split('=')[1].slice(0,-6));
	oauth2Client.setCredentials(tokens);
	console.log('Authenticated with Google');
	win.loadURL('https://tass.twgs.qld.edu.au/StudentCafe/login.cfm');
};

app.on('ready', createWindow);

app.on('win-all-closed', () => {
	if (process.platform !== 'darwin') app.quit()
});

app.on('activate', () => {
	if (!win) createWindow()
});

const awaitTimetable = () => {
	win.webContents.executeJavaScript(`document.getElementsByClassName('slick-row')`, rows => {
		if (!Object.values(rows).length) {
			setTimeout(awaitTimetable, 500)
		} else {
			syncCalendar();
		}
	})
};

const cheerio = require('cheerio');
let eventHolder = {};
const assignWeek = {true: 'A ', false: 'B '};
const assignDay = {0: 'MONDAY', 1: 'TUESDAY', 2: 'WEDNESDAY', 3: 'THURSDAY', 4: 'FRIDAY'};

const syncCalendar = () => {
	win.webContents.executeJavaScript(`document.body.innerHTML`, data => {
		win.loadFile('index.html');
		const $ = cheerio.load(data);
		const endDate = END_DATE.replace(/-/g, '');
		for (let i = 0; i < 6; i++) {
			for (let j = 0; j < 10; j++) {
				let period = "$('.grid-canvas').find('.ui-widget-content').eq(" + i + ").find('.slick-cell').eq(" + j + ").find('.ttClass').find";
				let timeslot = eval(period + "('div').eq(2).text()");
				if (eval(period + "('strong').text()") !== '') {
					eventHolder['WEEK ' + assignWeek[j < 5] + assignDay[j % 5] + ' PERIOD ' + (i + 1).toString()] = {
						'summary': eval(period + "('strong').text()"),
						'location': SCHOOL,
						'description': eval(period + "('div').eq(0).text()") + '\n' + eval(period + "('div').eq(1).text()"),
						'start': {
							'dateTime': getDay(j) + 'T' + getGoogleTime(timeslot.slice(0, timeslot.indexOf(' '))),
							'timeZone': TIME_ZONE
						},
						'end': {
							'dateTime': getDay(j) + 'T' + getGoogleTime(timeslot.slice(timeslot.lastIndexOf(' ') + 1, timeslot.length)),
							'timeZone': TIME_ZONE
						},
						'recurrence': [
							'RRULE:' +
							'FREQ=WEEKLY;' +
							'INTERVAL=2;' +
							'UNTIL=' + endDate + ';' +
							'BYDAY=' + assignDay[j % 5].slice(0, 2)
						],
						/*'attendees': [ //TODO - possible feature: add teachers/classmates as attendees? would require JSON/database of Google emails + teachers minimum, classmate emails by class too
							{'email': 'lpage@example.com'},
							{'email': 'sbrin@example.com'},
						],*/
						'reminders': {
							'useDefault': true //uses calendar defaults, overrides are redundant
							/*'overrides': [
								{'method': 'email', 'minutes': 24 * 60},
								{'method': 'popup', 'minutes': 10},
							],*/
						}
					}
				}
			}
		}
		//console.log(eventHolder);
		win.webContents.executeJavaScript(`document.getElementById('state').innerHTML = 'Uploading timetable'`);
		uploadEvents();
	});
}; //TODO - remove sketchy eval() and replace with native cheerio method (must be somewhere in the docs)

function getGoogleTime(regTime) {
	const time = regTime.substring(0,regTime.length-2);
	const modifier = regTime.substring(regTime.length-2);

	let [hours, minutes] = time.split(':');

	if (hours === '12') {
		hours = '00';
	}

	if (modifier === 'pm') {
		hours = parseInt(hours, 10) + 12;
	}

	return `${hours}:${minutes}:00+10:00`; //+10:00
}

function getDay(j) {
	let d = new Date(START_DATE);
	if (j>4) {
		j += 2;
	}
	d.setDate(d.getDate()+j);
	return d.toISOString().slice(0,10);
}

function uploadEvents() {
	/* Global options unnecessary for now*/
	google.options({
		auth: oauth2Client
	});

	const calendar = google.calendar('v3');

	const events = Object.keys(eventHolder);

	let eventCount = 0;
	let waitTime = 50;

	function recurs() {
		eventCount++;
		if (eventCount < events.length) {
			recursiveEventInsert();
		} else {
			win.webContents.executeJavaScript(`
				let state = document.getElementById('state');
				state.classList.remove('loading');
				state.innerHTML = 'Timetable uploaded';
				document.getElementById('showbox').hidden = true;
			`);
			console.log('Timetable upload complete')
		}
	}

	function recursiveEventInsert() {
		calendar.events.insert({
			auth: oauth2Client,
			calendarId: CALENDAR_ID,
			resource: eventHolder[events[eventCount]]
		}, function (err, event) {
			if (err) {
				console.log('There was an error contacting the Calendar service: ' + err);
				if (waitTime === 1600) win.webContents.executeJavaScript(`document.getElementById('state').innerHTML = 'Trouble contacting Google,<br>please check your internet'`);
				if (waitTime < 25600) waitTime *= 2;
				return;
			}
			if (waitTime > 50) {
				win.webContents.executeJavaScript(`document.getElementById('state').innerHTML = 'Uploading timetable'`);
				waitTime = 50;
			}
			console.log('Event created: ', event);
		});

		setTimeout(recurs, waitTime);
	}

	const calendarFailLoop = () => {
		calendar.calendars.insert({
			auth: oauth2Client,
			resource: {
				'summary': 'Timetable',
				'timeZone': TIME_ZONE
			}
		}, (err, event) => {
			if (err) {
				console.log(err);
				if (waitTime === 4000) win.webContents.executeJavaScript(`document.getElementById('state').innerHTML = 'Trouble contacting Google,<br>please check your internet'`);
				if (waitTime < 8000) waitTime *= 2;
				setTimeout(calendarFailLoop, waitTime);
				return;
			} else {
				console.log(`Calendar created: ${event.data.id}`);
				CALENDAR_ID = event.data.id;
				waitTime = 1000;
				recursiveEventInsert();
			}
		});
	};
	calendarFailLoop();
}