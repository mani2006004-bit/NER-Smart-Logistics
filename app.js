// ============================================================
// NER SMART LOGISTICS
// Main Application JavaScript
// ============================================================

// =========================
// SUPABASE CONFIGURATION
// =========================

const SUPABASE_URL = "https://gesdxbrlbnpyvtkxweky.supabase.co";

const SUPABASE_KEY =
    "sb_publishable_PA_vwys9qbkzhBv8jQDgFA_Yg_FUiIN";

const supabaseClient = window.supabase
    ? window.supabase.createClient(
        SUPABASE_URL,
        SUPABASE_KEY
    )
    : null;

if (!supabaseClient) {
    console.error("Supabase failed to load. Check the CDN script tag.");
}


// =========================
// MAP INITIALIZATION
// =========================

const map = window.L
    ? L.map("map").setView([25.5, 91.5], 7)
    : null;

if (map) {
    L.tileLayer(
        "https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png",
        {
            maxZoom: 19,
            attribution: "&copy; OpenStreetMap contributors"
        }
    ).addTo(map);
} else {
    console.error("Leaflet failed to load. Check the Leaflet CDN script tag.");
}


// =========================
// GLOBAL VARIABLES
// =========================

let routeLine = null;
let currentRouteOptions = [];
let currentRouteGeometry = null;
let currentRouteCoordinates = [];
let routeLayers = [];
let activeRouteOptionIndex = 0;
let floodHazardMarkers = [];
let landslideHazardMarkers = [];

let startMarker = null;
let endMarker = null;

let issueMarkers = [];

let currentRouteStart = null;
let currentRouteEnd = null;
let currentActiveIssues = [];
let roadIssuesDataAvailable = false;
let realtimeChannelInitialized = false;

let alertedIssueIds = new Set();

let routeWeatherData = null;
let routeWeatherMarkers = [];
let currentRouteDurationSeconds = 0;
let routeWeatherRequestId = 0;
let currentRouteRisk = null;
let dashboardInitialized = false;
let routeWeatherLoading = false;
let routeAnalyzing = false;
let routeTerrainData = null;
let routeTerrainMarkers = [];
let routeTerrainLoading = false;
let routeTerrainRequestId = 0;
let routeOptionsRequestId = 0;
let routeWeatherCache = new Map();
let aiRouteIntelligence = null;
let aiRouteIntelligenceLoading = false;
let aiRouteIntelligenceRequestId = 0;
let isOffline = !navigator.onLine;
let isSyncingPendingIssues = false;
let pendingIssueMarkers = [];
let reconnectSyncTimer = null;
let lastOfflineStatusMessage = "";

const OFFLINE_STORAGE_KEYS = {
    routeSnapshot: "nerSmartLogistics.routeSnapshot.v1",
    pendingIssues: "nerSmartLogistics.pendingIssues.v1"
};

const OFFLINE_SNAPSHOT_VERSION = 1;


function readLocalJson(key, fallback) {
    try {
        const value = localStorage.getItem(key);
        return value ? JSON.parse(value) : fallback;
    } catch (error) {
        console.warn(`Unable to read local storage key ${key}:`, error.message || error);
        return fallback;
    }
}


function writeLocalJson(key, value) {
    try {
        localStorage.setItem(key, JSON.stringify(value));
        return true;
    } catch (error) {
        console.warn(`Unable to write local storage key ${key}:`, error.message || error);
        return false;
    }
}


function readPendingIssues() {
    const issues = readLocalJson(OFFLINE_STORAGE_KEYS.pendingIssues, []);
    if (!Array.isArray(issues)) return [];

    return issues.filter(issue =>
        issue && typeof issue.localId === "string" &&
        typeof issue.issue_type === "string" &&
        Number.isFinite(Number(issue.latitude)) &&
        Number.isFinite(Number(issue.longitude)) &&
        issue.status === "pending_sync"
    );
}


function writePendingIssues(issues) {
    writeLocalJson(OFFLINE_STORAGE_KEYS.pendingIssues, issues);
}


function getCacheAgeText(timestamp) {
    const ageMs = Date.now() - new Date(timestamp || 0).getTime();
    if (!Number.isFinite(ageMs) || ageMs < 0) return "Cached just now";
    const minutes = Math.floor(ageMs / 60000);
    if (minutes < 1) return "Cached just now";
    if (minutes < 60) return `Cached ${minutes} minute${minutes === 1 ? "" : "s"} ago`;
    const hours = Math.floor(minutes / 60);
    return `Cached ${hours} hour${hours === 1 ? "" : "s"} ago`;
}


function getSnapshotTimestamp() {
    return readLocalJson(OFFLINE_STORAGE_KEYS.routeSnapshot, null)?.savedAt || null;
}


function createLocalIssueId() {
    if (crypto?.randomUUID) return crypto.randomUUID();
    return `offline-${Date.now()}-${Math.random().toString(36).slice(2)}-${Math.random().toString(36).slice(2)}`;
}


function updateNetworkStatus(message = "") {
    lastOfflineStatusMessage = message;
    const statusElement = document.getElementById("networkStatusValue");
    const messageElement = document.getElementById("networkStatusMessage");
    const indicator = document.getElementById("networkStatusIndicator");
    const pendingCount = readPendingIssues().length;

    if (statusElement) {
        statusElement.textContent = isOffline ? "🔴 OFFLINE" : isSyncingPendingIssues ? "🟡 SYNCING" : "🟢 LIVE";
    }
    if (indicator) indicator.className = isOffline ? "network-status-offline" : isSyncingPendingIssues ? "network-status-syncing" : "network-status-live";
    if (messageElement) {
        messageElement.textContent = message || (isOffline
            ? getSnapshotTimestamp() ? `${getCacheAgeText(getSnapshotTimestamp())}; GPS remains available` : "Cached route data unavailable"
            : pendingCount ? `${pendingCount} pending report${pendingCount === 1 ? "" : "s"}` : "Online data available");
    }
    updateSmartRouteDashboard();
}


function setOfflineState(nextOffline, message = "") {
    isOffline = Boolean(nextOffline);
    updateNetworkStatus(message);
}


function addPendingIssueMarker(issue) {
    if (!map || !Number.isFinite(Number(issue.latitude)) || !Number.isFinite(Number(issue.longitude))) return;
    const marker = L.marker([Number(issue.latitude), Number(issue.longitude)], {
        icon: L.divIcon({
            className: "pending-issue-marker",
            html: "<span>🟡</span>",
            iconSize: [30, 30],
            iconAnchor: [15, 15]
        })
    }).addTo(map);
    marker.bindPopup(`<strong>${issue.issue_type}</strong><br>${issue.description || "No description"}<br><br><strong>🟡 Pending Sync</strong><br>Created: ${new Date(issue.created_at).toLocaleString()}<br><small>This report has not yet reached the server.</small>`);
    pendingIssueMarkers.push({ localId: issue.localId, marker });
}


function removePendingIssueMarker(localId) {
    const entry = pendingIssueMarkers.find(item => item.localId === localId);
    if (!entry) return;
    if (map?.hasLayer(entry.marker)) map.removeLayer(entry.marker);
    pendingIssueMarkers = pendingIssueMarkers.filter(item => item.localId !== localId);
}


function renderCachedIssueMarkers(issues) {
    issues.forEach(issue => addIssueMarker(issue));
    readPendingIssues().forEach(issue => addPendingIssueMarker(issue));
}

let userLocationMarker = null;
let userAccuracyCircle = null;
let userHeadingCone = null;
let gpsWatchId = null;

let currentUserLocation = null;
let currentGpsAccuracy = null;
let followUserMode = false;
let hasCenteredOnLiveLocation = false;

let routeDistanceCompleted = 0;
let routeDistanceRemaining = null;
let distanceFromRoute = null;
let routeProgressPercentage = 0;
let arrivalState = null;


// =========================
// DEVICE COMPASS
// =========================

let compassEnabled = false;
let currentHeading = null;
let smoothedHeading = null;
let orientationListenerAttached = false;


function normalizeHeading(degrees) {
    const numericHeading = Number(degrees);

    if (!Number.isFinite(numericHeading)) {
        return null;
    }

    return (numericHeading % 360 + 360) % 360;
}


function getDirectionLabel(degrees) {
    const heading = normalizeHeading(degrees);

    if (heading === null) {
        return "N";
    }

    const directions = ["N", "NE", "E", "SE", "S", "SW", "W", "NW"];
    return directions[Math.floor((heading + 22.5) / 45) % 8];
}


function updateCompassUI(heading) {
    const normalizedHeading = normalizeHeading(heading);
    const headingElement = document.getElementById("compassHeading");
    const directionElement = document.getElementById("compassDirection");
    const needleElement = document.getElementById("compassNeedle");

    if (normalizedHeading === null) {
        return;
    }

    if (headingElement) {
        headingElement.textContent = `${Math.round(normalizedHeading)}°`;
    }

    if (directionElement) {
        directionElement.textContent = getDirectionLabel(normalizedHeading);
    }

    if (needleElement) {
        needleElement.style.transform = `translate(-50%, -50%) rotate(${-normalizedHeading}deg)`;
    }

    updateNavigationHeading(normalizedHeading);
    updateUserHeadingCone();
}


function setCompassStatus(message) {
    const statusElement = document.getElementById("compassStatus");

    if (statusElement) {
        statusElement.textContent = message;
    }
}


function handleDeviceOrientation(event) {
    let heading = null;

    if (Number.isFinite(Number(event.webkitCompassHeading))) {
        heading = Number(event.webkitCompassHeading);
    } else if (event.absolute === true && Number.isFinite(Number(event.alpha))) {
        heading = 360 - Number(event.alpha);
    }

    heading = normalizeHeading(heading);

    if (heading === null) {
        setCompassStatus("Waiting for compass sensor...");
        updateNavigationHeading(null);
        updateUserHeadingCone();
        return;
    }

    currentHeading = heading;

    if (smoothedHeading === null) {
        smoothedHeading = heading;
    } else {
        const shortestTurn = ((heading - smoothedHeading + 540) % 360) - 180;
        smoothedHeading = normalizeHeading(smoothedHeading + shortestTurn * 0.18);
    }

    updateCompassUI(smoothedHeading);
    setCompassStatus("Compass Active");
}


async function enableCompass() {
    const button = document.getElementById("enableCompassBtn");

    if (compassEnabled) {
        setCompassStatus("Compass Active");
        return;
    }

    if (typeof window.DeviceOrientationEvent === "undefined") {
        setCompassStatus("Compass sensor not supported on this device/browser.");
        return;
    }

    const isMobileDevice = /Android|iPhone|iPad|iPod|Mobile/i.test(navigator.userAgent);

    if (!isMobileDevice) {
        setCompassStatus("Compass sensor is available mainly on supported mobile devices.");
        return;
    }

    if (button) {
        button.disabled = true;
    }

    try {
        if (typeof window.DeviceOrientationEvent.requestPermission === "function") {
            const permission = await window.DeviceOrientationEvent.requestPermission(true);

            if (permission !== "granted") {
                setCompassStatus("Compass permission denied.");
                return;
            }
        }

        if (!orientationListenerAttached) {
            window.addEventListener("deviceorientation", handleDeviceOrientation, true);
            orientationListenerAttached = true;
        }

        compassEnabled = true;
        document.getElementById("compassControl")?.classList.add("is-active");
        setCompassStatus("Waiting for compass sensor...");
    } catch (error) {
        console.error("Compass permission or initialization error:", error);
        setCompassStatus("Compass permission denied.");
    } finally {
        if (button) {
            button.disabled = false;
        }
    }
}


function stopCompass() {
    if (orientationListenerAttached) {
        window.removeEventListener("deviceorientation", handleDeviceOrientation, true);
        orientationListenerAttached = false;
    }

    compassEnabled = false;
    currentHeading = null;
    smoothedHeading = null;
    setCompassStatus("Compass Off");
}


const enableCompassButton = document.getElementById("enableCompassBtn");

if (enableCompassButton) {
    enableCompassButton.addEventListener("click", enableCompass);
}


// =========================
// LIVE GPS NAVIGATION
// =========================

function formatDistance(meters, unknownText = "--") {
    if (!Number.isFinite(meters)) {
        return unknownText;
    }

    return meters >= 1000
        ? `${(meters / 1000).toFixed(1)} km`
        : `${Math.round(meters)} m`;
}


function setNavigationText(id, value) {
    const element = document.getElementById(id);

    if (element) {
        element.textContent = value;
    }

    updateSmartRouteDashboard();
}


function formatEta(seconds) {
    if (!currentRouteDurationSeconds || !Number.isFinite(seconds)) {
        return "--";
    }

    const minutes = Math.max(0, Math.round(seconds / 60));
    return minutes >= 60
        ? `${Math.floor(minutes / 60)} hr ${minutes % 60} min`
        : `${minutes} min`;
}


function getWeatherStatus(routeWeather) {
    if (!routeWeather?.points?.length) return "Unavailable";
    if (routeWeather.summary?.severeWeatherDetected) return "Severe";
    return routeWeather.summary?.maximumRainProbability >= 60 ? "Changing" : "Stable";
}


function getRouteIssueDistance(issue) {
    if (!currentUserLocation) return null;
    return distanceBetweenPoints(currentUserLocation.lat, currentUserLocation.lon, Number(issue.latitude), Number(issue.longitude));
}


function getRouteElevationPoints(routeCoordinates) {
    if (!Array.isArray(routeCoordinates) || routeCoordinates.length < 2) {
        return [];
    }

    let routeLength = 0;
    for (let index = 1; index < routeCoordinates.length; index++) {
        routeLength += distanceBetweenPoints(
            routeCoordinates[index - 1].lat,
            routeCoordinates[index - 1].lng,
            routeCoordinates[index].lat,
            routeCoordinates[index].lng
        );
    }

    const routeLengthKm = routeLength / 1000;
    const requestedSampleCount = routeLengthKm > 250
        ? 50
        : routeLengthKm > 100
            ? 35
            : routeLengthKm > 30
                ? 25
                : 20;
    const sampleCount = Math.min(requestedSampleCount, routeCoordinates.length);

    return Array.from({ length: sampleCount }, (_, index) => {
        const fraction = index / (sampleCount - 1);
        const routeIndex = Math.min(
            routeCoordinates.length - 1,
            Math.round(fraction * (routeCoordinates.length - 1))
        );
        const point = routeCoordinates[routeIndex];

        return {
            latitude: Number(point.lat),
            longitude: Number(point.lng),
            routePosition: index === 0
                ? "Start"
                : index === sampleCount - 1
                    ? "Destination"
                    : `${Math.round(fraction * 100)}% Route`,
            fraction
        };
    }).filter(point => Number.isFinite(point.latitude) && Number.isFinite(point.longitude));
}


function getTerrainDifficulty(maximumSlope) {
    const slope = Math.abs(Number(maximumSlope) || 0);

    if (slope > 10) return "VERY STEEP";
    if (slope > 6) return "STEEP";
    if (slope > 3) return "MODERATE";
    return "EASY";
}


function calculateTerrainDifficulty(terrainData) {
    return getTerrainDifficulty(terrainData?.summary?.maximumSlope || 0);
}


function generateTerrainSummary(terrainData) {
    if (!terrainData?.points?.length) {
        return "Terrain data temporarily unavailable.";
    }

    const summary = terrainData.summary;

    if (summary.maximumSlope > 10) {
        return "Very steep terrain section detected along the route.";
    }

    if (summary.maximumSlope > 6) {
        return "Several steep sections are present along the route.";
    }

    if (summary.maximumSlope > 3) {
        return "Moderate elevation changes occur along the route.";
    }

    if (summary.elevationDifference > 300) {
        return "A high-elevation section occurs along the route.";
    }

    return "Terrain is relatively gentle along the route.";
}


function removeRouteTerrainMarkers() {
    routeTerrainMarkers.forEach(marker => {
        if (map && map.hasLayer(marker)) {
            map.removeLayer(marker);
        }
    });

    routeTerrainMarkers = [];
}


function removeHazardMarkers() {
    [...floodHazardMarkers, ...landslideHazardMarkers].forEach(marker => {
        if (map && map.hasLayer(marker)) map.removeLayer(marker);
    });
    floodHazardMarkers = [];
    landslideHazardMarkers = [];
}


function addHazardMarker(point, icon, label, markerCollection) {
    if (!map || !point) return;
    const marker = L.marker([point.latitude, point.longitude], {
        icon: L.divIcon({
            className: "route-hazard-marker",
            html: `<span>${icon}</span><small>${label}</small>`,
            iconSize: [72, 24],
            iconAnchor: [36, 12]
        }),
        interactive: false,
        zIndexOffset: 130
    }).addTo(map);
    markerCollection.push(marker);
}


function showActiveHazardMarkers(option) {
    removeHazardMarkers();
    if (!option) return;

    const floodPoint = getWeatherHazardPoints(option.weatherData)[0];
    const landslidePoint = option.terrainData?.points?.find(point => point.isSteepest);
    if (option.floodIndicator?.score > 0) {
        addHazardMarker(floodPoint, "🌊", "Flood indicator", floodHazardMarkers);
    }
    if (option.landslideIndicator?.score > 0 && landslidePoint) {
        addHazardMarker(landslidePoint, "⛰️", "Landslide indicator", landslideHazardMarkers);
    }
}


function addTerrainMarker(point, icon, label) {
    if (!map || !point) return;

    const marker = L.marker([point.latitude, point.longitude], {
        icon: L.divIcon({
            className: "route-terrain-marker",
            html: `<span>${icon}</span><small>${label}</small>`,
            iconSize: [62, 24],
            iconAnchor: [31, 12]
        }),
        interactive: false,
        zIndexOffset: 120
    }).addTo(map);

    routeTerrainMarkers.push(marker);
}


function showRouteTerrainMarkers(terrainData) {
    removeRouteTerrainMarkers();

    if (!terrainData?.points?.length) return;

    const highestPoint = terrainData.points.reduce((highest, point) =>
        Number(point.elevation) > Number(highest?.elevation) ? point : highest,
    terrainData.points[0]);
    const steepestPoint = terrainData.points.find(point => point.isSteepest);

    addTerrainMarker(highestPoint, "🏔️", "Highest");
    if (steepestPoint && steepestPoint !== highestPoint) {
        addTerrainMarker(steepestPoint, "📈", "Steep");
    }
    addTerrainMarker(terrainData.points[terrainData.points.length - 1], "🏁", "Destination");
}


function createElevationProfile(terrainData) {
    const points = terrainData?.points || [];
    if (points.length < 2) return "";

    const elevations = points.map(point => Number(point.elevation));
    const minimum = Math.min(...elevations);
    const maximum = Math.max(...elevations);
    const range = Math.max(1, maximum - minimum);
    const profilePoints = points.map((point, index) => {
        const x = (index / (points.length - 1)) * 280 + 10;
        const y = 72 - ((Number(point.elevation) - minimum) / range) * 52;
        return `${x.toFixed(1)},${y.toFixed(1)}`;
    }).join(" ");

    return `<svg class="terrain-profile" viewBox="0 0 300 92" role="img" aria-label="Elevation profile"><line x1="10" y1="74" x2="290" y2="74" /><polyline points="${profilePoints}" /><text x="10" y="89">Start</text><text x="136" y="89">Route</text><text x="250" y="89">Destination</text><text x="12" y="12">${Math.round(maximum)} m</text></svg>`;
}


function renderTerrainDashboard(terrainData) {
    const summary = terrainData.summary;
    const steepMessage = summary.maximumSlope > 6
        ? `<div class="terrain-warning">⚠️ Steep terrain section detected near approximately ${summary.steepestRoutePosition}% of route.</div>`
        : "";
    const rainfallOverlap = summary.maximumSlope > 6 && routeWeatherData?.points?.some(point => Number(point.precipitationProbability || 0) >= 60)
        ? `<div class="terrain-warning">⚠️ Steep terrain with rainfall forecast near this section.</div>`
        : "";

    return `<div class="terrain-summary-grid"><span>Elevation<strong>${Math.round(summary.minimumElevation)}–${Math.round(summary.maximumElevation)} m</strong></span><span>Gain<strong>+${Math.round(summary.totalElevationGain)} m</strong></span><span>Loss<strong>${Math.round(summary.totalElevationLoss)} m</strong></span><span>Max slope<strong>${summary.maximumSlope.toFixed(1)}%</strong></span></div><div class="terrain-classification">Terrain: <strong>${terrainData.difficulty}</strong></div>${steepMessage}${rainfallOverlap}<div class="terrain-profile-wrap">${createElevationProfile(terrainData)}</div><div class="terrain-source">Elevation data: Copernicus DEM / Open-Meteo</div><button id="refreshTerrainBtn" class="dashboard-detail-button" type="button">Refresh Terrain</button>`;
}


function renderAlternativeRoutes() {
    if (routeAnalyzing) {
        return "<span class=\"dashboard-loading\">Analyzing alternative routes...</span>";
    }

    if (currentRouteOptions.length <= 1) {
        return currentRouteOptions.length === 1
            ? "<span class=\"dashboard-muted\">Only one route available for this journey.</span>"
            : "";
    }

    return `<div class="route-comparison-list">${currentRouteOptions.map(option => {
        const isActive = option.index === activeRouteOptionIndex;
        const issueDetails = Object.entries(option.issueCounts || {})
            .map(([type, count]) => `${count} ${type.toLowerCase()}`)
            .join(", ");
        const status = isActive ? "Active" : option.index === 0 ? "Primary" : "Alternative";
        const metrics = option.risk
            ? `Risk: ${option.riskLevel} (${option.riskScore}/100)`
            : "Risk: Unavailable";

        return `<article class="route-comparison-card${isActive ? " is-active" : ""}"><div class="route-comparison-heading"><strong>Route ${option.index + 1}</strong><span>${status}</span></div><div class="route-comparison-metrics"><span>${option.distanceKm.toFixed(1)} km</span><span>${formatRouteDuration(option.duration)}</span><span>${metrics}</span><span>Terrain: ${option.terrain || "Analyzing"}</span><span>Weather: ${option.weather || "Analyzing"}</span><span>Flood indicator: ${option.floodIndicator?.level || "Analyzing"}</span><span>Landslide indicator: ${option.landslideIndicator?.level || "Analyzing"}</span><span>Road issues: ${option.nearbyIssues.length}${issueDetails ? ` (${issueDetails})` : ""}</span></div>${option.index === activeRouteOptionIndex ? "" : `<button class="dashboard-detail-button" type="button" data-route-option="${option.index}">Use This Route</button>`}</article>`;
    }).join("")}</div>`;
}


function renderHazardIndicator(title, indicator) {
    if (!indicator) return `<div class="dashboard-muted">${title}: data unavailable.</div>`;
    const factors = indicator.factors.map(factor => `<li>${factor}</li>`).join("");
    const sections = indicator.affectedSections.length
        ? indicator.affectedSections.join("; ")
        : "No specific affected section identified.";
    return `<div class="hazard-indicator"><div class="hazard-indicator-heading"><strong>${title}</strong><span>${indicator.level} · ${indicator.score}/100</span></div><span>Factors</span><ul>${factors}</ul><span>Affected section: ${sections}</span><span>Confidence: ${indicator.confidence}</span></div>`;
}


function renderHazardDashboard(option) {
    if (routeAnalyzing) return "<span class=\"dashboard-loading\">Analyzing hazard indicators...</span>";
    if (!option) return "";
    return `${renderHazardIndicator("🌊 Flood Risk Indicator", option.floodIndicator)}${renderHazardIndicator("⛰️ Landslide Risk Indicator", option.landslideIndicator)}<p class="hazard-disclaimer">Indicators use current weather, terrain and reported road information. They are not disaster predictions.</p><div class="hazard-sources">Weather: Open-Meteo · Elevation: Open-Meteo / Copernicus DEM · Road incidents: Community reports / Supabase</div>`;
}


function getRouteIssueFacts(option) {
    const routePoints = (option?.coordinates || []).map(([lat, lng]) => ({ lat, lng }));
    const totalDistance = routePoints.slice(1).reduce((total, point, index) => {
        const previous = routePoints[index];
        return total + distanceBetweenPoints(previous.lat, previous.lng, point.lat, point.lng);
    }, 0);

    return (option?.nearbyIssues || []).map(issue => {
        let nearestDistance = Infinity;
        let distanceAlongRoute = 0;
        let traversedDistance = 0;
        const issueLat = Number(issue.latitude);
        const issueLng = Number(issue.longitude);

        for (let index = 1; index < routePoints.length; index++) {
            const start = routePoints[index - 1];
            const end = routePoints[index];
            const segmentDistance = distanceBetweenPoints(start.lat, start.lng, end.lat, end.lng);
            const latScale = 111320;
            const lonScale = 111320 * Math.cos(start.lat * Math.PI / 180);
            const bx = (end.lng - start.lng) * lonScale;
            const by = (end.lat - start.lat) * latScale;
            const px = (issueLng - start.lng) * lonScale;
            const py = (issueLat - start.lat) * latScale;
            const squared = bx * bx + by * by;
            const fraction = squared ? Math.max(0, Math.min(1, (px * bx + py * by) / squared)) : 0;
            const distance = Math.hypot(px - fraction * bx, py - fraction * by);

            if (distance < nearestDistance) {
                nearestDistance = distance;
                distanceAlongRoute = traversedDistance + segmentDistance * fraction;
            }
            traversedDistance += segmentDistance;
        }

        return {
            type: String(issue.issue_type || "Reported issue"),
            description: String(issue.description || "No description available.").slice(0, 240),
            active: issue.status === undefined ? true : issue.status === "active",
            distanceFromRouteMeters: Math.round(nearestDistance),
            approximatePosition: totalDistance > 0 ? `Around ${Math.round(distanceAlongRoute / totalDistance * 100)}% of route` : "Near route"
        };
    });
}


function getWeatherFacts(weatherData) {
    return (weatherData?.points || []).map(point => ({
        position: point.position,
        temperature: point.temperature,
        precipitation: point.precipitation,
        precipitationProbability: point.precipitationProbability,
        rain: point.rain,
        weather: point.description,
        severeWeather: isSevereWeather(point.weatherCode)
    }));
}


function getTerrainFacts(terrainData) {
    const summary = terrainData?.summary;
    if (!summary) return null;

    return {
        minimumElevation: summary.minimumElevation,
        maximumElevation: summary.maximumElevation,
        elevationGain: summary.totalElevationGain,
        elevationLoss: summary.totalElevationLoss,
        maximumSlope: summary.maximumSlope,
        classification: terrainData.difficulty,
        steepestSection: summary.steepestRoutePosition === undefined
            ? null
            : `Around ${summary.steepestRoutePosition}% of route`
    };
}


function getRouteComparisonFacts() {
    return currentRouteOptions.map(option => ({
        route: `Route ${option.index + 1}`,
        distanceKm: Number(option.distanceKm.toFixed(1)),
        durationMinutes: Math.round(option.durationMinutes),
        terrain: option.terrain || "Unavailable",
        weather: option.weather || "Unavailable",
        risk: option.risk ? { level: option.riskLevel, score: option.riskScore } : null,
        floodIndicator: option.floodIndicator ? { level: option.floodIndicator.level, score: option.floodIndicator.score } : null,
        landslideIndicator: option.landslideIndicator ? { level: option.landslideIndicator.level, score: option.landslideIndicator.score } : null,
        roadIssues: option.nearbyIssues.length
    }));
}


function buildAiRouteFacts() {
    const option = currentRouteOptions[activeRouteOptionIndex];
    if (!option) return null;

    return {
        route: {
            start: currentRouteStart?.displayName || "Start location unavailable",
            destination: currentRouteEnd?.displayName || "Destination unavailable",
            activeRoute: `Route ${option.index + 1}`,
            distanceKm: Number(option.distanceKm.toFixed(1)),
            durationMinutes: Math.round(option.durationMinutes)
        },
        weather: {
            summary: option.weatherData?.summary || null,
            samples: getWeatherFacts(option.weatherData)
        },
        terrain: getTerrainFacts(option.terrainData),
        roadIssues: getRouteIssueFacts(option),
        risk: option.risk ? {
            level: option.risk.level,
            score: option.risk.score,
            reasons: option.risk.reasons
        } : null,
        floodIntelligence: option.floodIndicator ? {
            level: option.floodIndicator.level,
            score: option.floodIndicator.score,
            factors: option.floodIndicator.factors,
            affectedSections: option.floodIndicator.affectedSections,
            confidence: option.floodIndicator.confidence
        } : null,
        landslideIntelligence: option.landslideIndicator ? {
            level: option.landslideIndicator.level,
            score: option.landslideIndicator.score,
            factors: option.landslideIndicator.factors,
            affectedSections: option.landslideIndicator.affectedSections,
            confidence: option.landslideIndicator.confidence
        } : null,
        alternatives: getRouteComparisonFacts()
    };
}


function renderAiRouteIntelligence() {
    if (isOffline) {
        return "<div class=\"dashboard-muted\">AI Route Intelligence is unavailable offline. Reconnect to use the latest AI assessment.</div>";
    }
    if (aiRouteIntelligenceLoading) {
        return "<span class=\"dashboard-loading\">Generating AI route assessment...</span>";
    }
    if (!aiRouteIntelligence) {
        return "<div class=\"dashboard-muted\">Use the button to generate a briefing from the current route data.</div><button id=\"generateAiRouteBtn\" class=\"dashboard-detail-button\" type=\"button\">🤖 AI Route Intelligence</button>";
    }
    if (aiRouteIntelligence.error) {
        return `<div class="dashboard-muted">${aiRouteIntelligence.error}</div><button id="generateAiRouteBtn" class="dashboard-detail-button" type="button">Retry AI Assessment</button>`;
    }

    const list = values => (values || []).map(value => `<li>${value}</li>`).join("");
    return `<div class="ai-route-result"><strong>AI Journey Briefing</strong><p>${aiRouteIntelligence.summary}</p><strong>Key Factors</strong><ul>${list(aiRouteIntelligence.key_factors)}</ul><strong>Weather</strong><p>${aiRouteIntelligence.weather_summary}</p><strong>Terrain</strong><p>${aiRouteIntelligence.terrain_summary}</p><strong>Road Issues</strong><p>${aiRouteIntelligence.road_issue_summary}</p><strong>Risk Explanation</strong><p>${aiRouteIntelligence.risk_explanation}</p><strong>Route Comparison</strong><p>${aiRouteIntelligence.route_comparison}</p><strong>Logistics Guidance</strong><p>${aiRouteIntelligence.logistics_guidance}</p><strong>Cautions</strong><ul>${list(aiRouteIntelligence.cautions)}</ul></div><button id="generateAiRouteBtn" class="dashboard-detail-button" type="button">Refresh AI Assessment</button>`;
}


function invalidateAiRouteIntelligence() {
    aiRouteIntelligence = null;
    aiRouteIntelligenceRequestId++;
    aiRouteIntelligenceLoading = false;
}


async function requestAiRouteIntelligence() {
    if (isOffline) {
        aiRouteIntelligence = { error: "AI Route Intelligence is unavailable offline. Reconnect to use the latest AI assessment." };
        aiRouteIntelligenceLoading = false;
        updateSmartRouteDashboard();
        return;
    }

    const facts = buildAiRouteFacts();
    if (!facts) return;

    const requestId = ++aiRouteIntelligenceRequestId;
    aiRouteIntelligenceLoading = true;
    aiRouteIntelligence = null;
    updateSmartRouteDashboard();

    try {
        const response = await fetch("/api/ai/route-intelligence", {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify(facts)
        });
        const data = await response.json();
        if (!response.ok) throw new Error(data.error || "AI route assessment failed.");
        if (requestId === aiRouteIntelligenceRequestId) aiRouteIntelligence = data;
    } catch (error) {
        console.error("AI route intelligence error:", error);
        if (requestId === aiRouteIntelligenceRequestId) {
            aiRouteIntelligence = { error: "AI route assessment is temporarily unavailable." };
        }
    } finally {
        if (requestId === aiRouteIntelligenceRequestId) {
            aiRouteIntelligenceLoading = false;
            updateSmartRouteDashboard();
        }
    }
}


function buildTerrainModel(sampledPoints, elevations) {
    const validPoints = sampledPoints.map((point, index) => ({
        ...point,
        elevation: Number(elevations[index])
    })).filter(point => Number.isFinite(point.elevation));

    if (validPoints.length < 2) return null;

    let totalElevationGain = 0;
    let totalElevationLoss = 0;
    let maximumSlope = 0;
    let steepestIndex = 0;

    validPoints.forEach((point, index) => {
        if (index === 0) return;

        const previous = validPoints[index - 1];
        const horizontalDistance = distanceBetweenPoints(previous.latitude, previous.longitude, point.latitude, point.longitude);
        const elevationChange = point.elevation - previous.elevation;

        if (elevationChange > 0) totalElevationGain += elevationChange;
        if (elevationChange < 0) totalElevationLoss += -elevationChange;

        const grade = horizontalDistance > 0 ? Math.abs(elevationChange / horizontalDistance * 100) : 0;
        point.grade = grade;
        if (grade > maximumSlope) {
            maximumSlope = grade;
            steepestIndex = index;
        }
    });

    validPoints[steepestIndex].isSteepest = true;

    const elevationsOnly = validPoints.map(point => point.elevation);
    const summary = {
        minimumElevation: Math.min(...elevationsOnly),
        maximumElevation: Math.max(...elevationsOnly),
        totalElevationGain,
        totalElevationLoss,
        elevationDifference: Math.max(...elevationsOnly) - Math.min(...elevationsOnly),
        maximumSlope,
        steepestRoutePosition: Math.round(validPoints[steepestIndex].fraction * 100)
    };

    const terrainData = { points: validPoints, summary, difficulty: getTerrainDifficulty(maximumSlope) };
    return terrainData;
}


function getRouteCoordinates(route) {
    return Array.isArray(route?.geometry?.coordinates)
        ? route.geometry.coordinates.map(point => [Number(point[1]), Number(point[0])])
        : [];
}


function removeRouteLayers() {
    routeLayers.forEach(layer => {
        if (map && map.hasLayer(layer)) {
            map.removeLayer(layer);
        }
    });
    routeLayers = [];
}


function updateRouteLayerStyles() {
    currentRouteOptions.forEach(option => {
        if (!option.layer) return;

        const isActive = option.index === activeRouteOptionIndex;
        option.layer.setStyle({
            color: isActive ? "#2563eb" : option.index === 0 ? "#64748b" : "#f59e0b",
            weight: isActive ? 7 : 4,
            opacity: isActive ? 0.9 : 0.55,
            dashArray: isActive ? null : option.index === 0 ? "8 6" : "5 8"
        });
        if (isActive) option.layer.bringToFront();
    });
}


function renderRouteLayers() {
    removeRouteLayers();

    currentRouteOptions.forEach(option => {
        option.layer = L.polyline(option.coordinates, {
            color: option.index === 0 ? "#2563eb" : "#f59e0b",
            weight: option.index === 0 ? 6 : 4,
            opacity: option.index === 0 ? 0.8 : 0.55,
            dashArray: option.index === 0 ? null : "5 8"
        }).addTo(map);
        routeLayers.push(option.layer);
    });

    updateRouteLayerStyles();
}


function getIssueTypeCounts(issues) {
    const counts = {};
    (issues || []).forEach(issue => {
        counts[issue.issue_type] = (counts[issue.issue_type] || 0) + 1;
    });
    return counts;
}


async function fetchTerrainForCoordinates(routeCoordinates) {
    const sampledPoints = getRouteElevationPoints(routeCoordinates.map(([lat, lng]) => ({ lat, lng })));
    if (sampledPoints.length < 2) return null;

    const latitude = sampledPoints.map(point => point.latitude).join(",");
    const longitude = sampledPoints.map(point => point.longitude).join(",");
    const response = await fetch(`https://api.open-meteo.com/v1/elevation?latitude=${latitude}&longitude=${longitude}`);

    if (!response.ok) throw new Error(`Elevation API returned HTTP ${response.status}`);

    const data = await response.json();
    return Array.isArray(data.elevation) ? buildTerrainModel(sampledPoints, data.elevation) : null;
}


async function fetchRouteTerrain() {
    if (!routeLine) return null;

    const requestId = ++routeTerrainRequestId;
    const sampledPoints = getRouteElevationPoints(routeLine.getLatLngs());

    if (sampledPoints.length < 2) return null;

    routeTerrainLoading = true;
    updateSmartRouteDashboard();

    try {
        const latitude = sampledPoints.map(point => point.latitude).join(",");
        const longitude = sampledPoints.map(point => point.longitude).join(",");
        const response = await fetch(`https://api.open-meteo.com/v1/elevation?latitude=${latitude}&longitude=${longitude}`);

        if (!response.ok) throw new Error(`Elevation API returned HTTP ${response.status}`);

        const data = await response.json();
        if (requestId !== routeTerrainRequestId || !Array.isArray(data.elevation)) return null;

        const terrainData = buildTerrainModel(sampledPoints, data.elevation);
        routeTerrainData = terrainData;
        if (terrainData) showRouteTerrainMarkers(terrainData);
        return terrainData;
    } catch (error) {
        console.warn("Terrain data unavailable:", error.message || error);
        routeTerrainData = null;
        removeRouteTerrainMarkers();
        return null;
    } finally {
        if (requestId === routeTerrainRequestId) {
            routeTerrainLoading = false;
            updateSmartRouteDashboard();
        }
    }
}


async function refreshRouteTerrain() {
    if (!routeLine) return;
    if (isOffline) {
        updateNetworkStatus("Offline: using cached terrain intelligence");
        return;
    }
    invalidateAiRouteIntelligence();
    await fetchRouteTerrain();
    const nearbyIssues = getNearbyRouteIssues(currentActiveIssues);
    const activeOption = currentRouteOptions[activeRouteOptionIndex];
    if (activeOption) {
        activeOption.terrainData = routeTerrainData;
        activeOption.terrain = routeTerrainData?.difficulty || "Unavailable";
        activeOption.nearbyIssues = nearbyIssues;
        activeOption.issueCounts = getIssueTypeCounts(nearbyIssues);
        activeOption.risk = calculateRouteRisk(null, null, nearbyIssues, routeWeatherData, routeTerrainData);
        activeOption.riskScore = activeOption.risk.score;
        activeOption.riskLevel = activeOption.risk.level;
        activeOption.riskReasons = activeOption.risk.reasons;
        updateRouteOptionHazards(activeOption);
        showActiveHazardMarkers(activeOption);
        saveRouteSnapshot();
    }
    showRouteRiskCard(calculateRouteRisk(null, null, nearbyIssues, routeWeatherData, routeTerrainData));
}


function updateSmartRouteDashboard() {
    const dashboard = document.getElementById("smartRouteDashboard");
    if (!dashboard) return;

    const hasRoute = Boolean(routeLine && currentRouteStart && currentRouteEnd);
    dashboard.classList.toggle("has-route", hasRoute);

    const routeState = document.getElementById("dashboardRouteState");
    if (routeState) {
        routeState.textContent = hasRoute
            ? "Route ready"
            : currentRouteStart && currentRouteEnd
                ? "Analyzing route..."
                : "Route monitoring workspace";
    }

    const emptyState = document.getElementById("dashboardEmptyState");
    if (emptyState) emptyState.hidden = hasRoute;

    const progressValue = document.getElementById("navigationProgress")?.textContent || "--";
    const navValue = document.getElementById("dashboardNavigationValue");
    if (navValue) navValue.textContent = hasRoute ? progressValue : "No route";

    const weatherValue = document.getElementById("dashboardWeatherValue");
    if (weatherValue) weatherValue.textContent = hasRoute ? getWeatherStatus(routeWeatherData) : "No route";

    const riskValue = document.getElementById("dashboardRiskValue");
    if (riskValue) riskValue.textContent = hasRoute && currentRouteRisk ? currentRouteRisk.level : "No route";

    const nearbyIssues = hasRoute ? getNearbyRouteIssues(currentActiveIssues) : [];
    const issueValue = document.getElementById("dashboardIssuesValue");
    if (issueValue) issueValue.textContent = hasRoute ? `${nearbyIssues.length} near route` : "No route";

    const terrainValue = document.getElementById("dashboardTerrainValue");
    if (terrainValue) terrainValue.textContent = hasRoute
        ? routeTerrainData?.difficulty || (routeTerrainLoading ? "Analyzing" : "Unavailable")
        : "No route";

    const alternativesValue = document.getElementById("dashboardAlternativesValue");
    if (alternativesValue) alternativesValue.textContent = hasRoute
        ? routeAnalyzing
            ? "Analyzing"
            : currentRouteOptions.length > 1
                ? `${currentRouteOptions.length} routes`
                : currentRouteOptions.length === 1
                    ? "1 route"
                    : "Unavailable"
        : "No route";

    const hazardValue = document.getElementById("dashboardHazardValue");
    const activeOption = currentRouteOptions[activeRouteOptionIndex];
    if (hazardValue) hazardValue.textContent = hasRoute
        ? activeOption?.floodIndicator && activeOption?.landslideIndicator
            ? `${activeOption.floodIndicator.level}/${activeOption.landslideIndicator.level}`
            : routeAnalyzing ? "Analyzing" : "Unavailable"
        : "No route";

    const aiValue = document.getElementById("dashboardAiValue");
    if (aiValue) aiValue.textContent = !hasRoute
        ? "No route"
        : aiRouteIntelligenceLoading
            ? "Generating"
            : aiRouteIntelligence?.error
                ? "Error"
            : aiRouteIntelligence
                ? "Available"
                : "Ready";

    const dataStatusValue = document.getElementById("dashboardDataStatusValue");
    if (dataStatusValue) dataStatusValue.textContent = isOffline ? "Offline" : isSyncingPendingIssues ? "Syncing" : "Live";

    const etaElement = document.getElementById("navigationEta");
    if (etaElement) etaElement.textContent = hasRoute && routeDistanceRemaining !== null
        ? formatEta(currentRouteDurationSeconds * (1 - routeProgressPercentage / 100))
        : "--";

    const dataStatusBody = document.getElementById("dashboardDataStatusBody");
    if (dataStatusBody) {
        const snapshotAge = getSnapshotTimestamp();
        const cachedText = snapshotAge ? getCacheAgeText(snapshotAge) : "No cached route";
        const pendingCount = readPendingIssues().length;
        dataStatusBody.innerHTML = `<div class="data-status-summary"><strong id="networkStatusIndicator" class="${isOffline ? "network-status-offline" : isSyncingPendingIssues ? "network-status-syncing" : "network-status-live"}">${isOffline ? "🔴 OFFLINE" : isSyncingPendingIssues ? "🟡 SYNCING" : "🟢 LIVE"}</strong><span id="networkStatusMessage">${lastOfflineStatusMessage || (isOffline ? cachedText : "Online data available")}</span></div><div class="data-status-grid"><span>Route<strong>${isOffline ? `Cached · ${cachedText.replace("Cached ", "")}` : hasRoute ? "Live" : "No route"}</strong></span><span>Weather<strong>${isOffline ? `Cached · ${cachedText.replace("Cached ", "")}` : hasRoute ? "Live" : "No route"}</strong></span><span>Road Issues<strong>${isOffline ? `Cached · ${cachedText.replace("Cached ", "")}` : "Live"}</strong></span><span>AI<strong>${isOffline ? "Unavailable offline" : aiRouteIntelligence?.error ? "Unavailable" : "Available on request"}</strong></span><span>Pending Reports<strong>${pendingCount}</strong></span></div>`;
    }

    const weatherBody = document.getElementById("dashboardWeatherBody");
    if (weatherBody && hasRoute) {
        const summary = routeWeatherData?.summary;
        weatherBody.innerHTML = routeWeatherLoading
            ? "<span class=\"dashboard-loading\">🌦️ Updating route weather...</span>"
            : routeWeatherData?.points?.length
            ? `<div class="dashboard-weather-summary"><strong>${summaryTemperature(summary, routeWeatherData)}</strong><span>${isOffline ? "Cached weather — " + getCacheAgeText(getSnapshotTimestamp()) : "Live weather"}</span><span>Max rain probability: ${summary.maximumRainProbability}%</span><span>Max rainfall: ${summary.maximumRainfall.toFixed(1)} mm</span><span>Max wind: ${summary.maximumWindSpeed.toFixed(1)} km/h</span><em>${generateRouteWeatherSummary(routeWeatherData)}</em></div><div class="dashboard-weather-actions"><button id="dashboardWeatherDetails" class="dashboard-detail-button" type="button">View Details ▾</button><button id="refreshWeatherBtn" class="dashboard-detail-button" type="button">Refresh Weather</button></div><div id="dashboardWeatherDetailsBody" class="dashboard-detail-list" hidden>${routeWeatherData.points.map(point => `<div><strong>${point.position}</strong><span>${Number(point.temperature).toFixed(0)}°C · ${point.description}</span><small>Rain ${Number(point.rain || 0).toFixed(1)} mm · Probability ${point.precipitationProbability ?? "--"}%</small></div>`).join("")}</div>`
            : "<span class=\"dashboard-muted\">Temporarily unavailable</span>";
    } else if (weatherBody) {
        weatherBody.innerHTML = "";
    }

    const riskBody = document.getElementById("dashboardRiskBody");
    if (riskBody) {
        riskBody.innerHTML = hasRoute && currentRouteRisk
            ? `<div class="dashboard-risk-score">${currentRouteRisk.level} <strong>${currentRouteRisk.score} / 100</strong></div><ul>${currentRouteRisk.reasons.map(reason => `<li>${reason}</li>`).join("") || "<li>Weather conditions appear stable.</li>"}</ul>`
            : "";
    }

    const issueBody = document.getElementById("dashboardIssuesBody");
    if (issueBody) {
        issueBody.innerHTML = !hasRoute
            ? ""
            : nearbyIssues.length
                ? `<div class="dashboard-muted">${isOffline ? "Cached reports — " + getCacheAgeText(getSnapshotTimestamp()) : "Live reports"}</div>${nearbyIssues.map(issue => `<div class="dashboard-issue-item"><strong>${issue.issue_type}</strong><span>${getRouteIssueDistance(issue) === null ? "Near route" : `${formatDistance(getRouteIssueDistance(issue))} away`}</span></div>`).join("")}`
                : "<div class=\"dashboard-muted\">✓ No reported road issues near route</div>";
    }

    const terrainBody = document.getElementById("dashboardTerrainBody");
    if (terrainBody) {
        terrainBody.innerHTML = !hasRoute
            ? ""
            : routeTerrainLoading
                ? "<span class=\"dashboard-loading\">🏔️ Analyzing terrain...</span>"
                : routeTerrainData
                    ? renderTerrainDashboard(routeTerrainData)
                    : "<div class=\"dashboard-muted\">Terrain data temporarily unavailable.</div>";
    }

    const alternativesBody = document.getElementById("dashboardAlternativesBody");
    if (alternativesBody) {
        alternativesBody.innerHTML = renderAlternativeRoutes();
    }

    const hazardBody = document.getElementById("dashboardHazardBody");
    if (hazardBody) {
        hazardBody.innerHTML = !hasRoute
            ? ""
            : renderHazardDashboard(currentRouteOptions[activeRouteOptionIndex]);
    }

    const aiBody = document.getElementById("dashboardAiBody");
    if (aiBody) {
        aiBody.innerHTML = !hasRoute ? "" : renderAiRouteIntelligence();
    }

    if (!dashboardInitialized) {
        dashboard.querySelectorAll(".dashboard-section-header").forEach(header => {
            header.addEventListener("click", () => {
                const section = header.closest(".dashboard-section");
                const open = section.classList.toggle("is-open");
                header.setAttribute("aria-expanded", String(open));

                if (open && window.matchMedia("(max-width: 800px)").matches) {
                    dashboard.querySelectorAll(".dashboard-section.is-open").forEach(otherSection => {
                        if (otherSection !== section) {
                            otherSection.classList.remove("is-open");
                            otherSection.querySelector(".dashboard-section-header")?.setAttribute("aria-expanded", "false");
                        }
                    });
                }
            });
        });

        dashboard.querySelector("#dashboardMinimizeBtn")?.addEventListener("click", () => {
            dashboard.classList.toggle("is-minimized");
        });

        dashboard.addEventListener("click", event => {
            if (event.target.id === "dashboardWeatherDetails") {
                const detailBody = document.getElementById("dashboardWeatherDetailsBody");
                if (detailBody) detailBody.hidden = !detailBody.hidden;
            }

            if (event.target.id === "refreshWeatherBtn") {
                refreshRouteWeather();
            }

            if (event.target.id === "refreshTerrainBtn") {
                refreshRouteTerrain();
            }

            const routeButton = event.target.closest("[data-route-option]");
            if (routeButton) {
                selectRouteOption(routeButton.dataset.routeOption);
            }

            if (event.target.closest("#generateAiRouteBtn")) {
                requestAiRouteIntelligence();
            }
        });

        dashboardInitialized = true;
    }
}


function updateNavigationHeading(heading) {
    const normalizedHeading = normalizeHeading(heading);

    setNavigationText(
        "navigationHeading",
        normalizedHeading === null
            ? "Unavailable"
            : `${getDirectionLabel(normalizedHeading)} ${Math.round(normalizedHeading)}°`
    );
}


function createUserLocationMarker() {
    return L.marker(
        [currentUserLocation.lat, currentUserLocation.lon],
        {
            icon: L.divIcon({
                className: "user-location-icon",
                html: `
                    <div class="user-location-marker">
                        <div class="location-pulse"></div>
                        <div class="location-dot"></div>
                    </div>
                `,
                iconSize: [30, 30],
                iconAnchor: [15, 15]
            }),
            interactive: false,
            zIndexOffset: 1000
        }
    ).addTo(map);
}


function destinationPoint(latitude, longitude, distanceMeters, bearingDegrees) {
    const earthRadius = 6371000;
    const angularDistance = distanceMeters / earthRadius;
    const bearing = bearingDegrees * Math.PI / 180;
    const latitudeRadians = latitude * Math.PI / 180;
    const longitudeRadians = longitude * Math.PI / 180;

    const destinationLatitude = Math.asin(
        Math.sin(latitudeRadians) * Math.cos(angularDistance) +
        Math.cos(latitudeRadians) * Math.sin(angularDistance) * Math.cos(bearing)
    );

    const destinationLongitude = longitudeRadians + Math.atan2(
        Math.sin(bearing) * Math.sin(angularDistance) * Math.cos(latitudeRadians),
        Math.cos(angularDistance) - Math.sin(latitudeRadians) * Math.sin(destinationLatitude)
    );

    return [
        destinationLatitude * 180 / Math.PI,
        ((destinationLongitude * 180 / Math.PI + 540) % 360) - 180
    ];
}


function updateUserHeadingCone() {
    const heading = smoothedHeading === null ? currentHeading : smoothedHeading;

    if (!map || !currentUserLocation || heading === null) {
        if (userHeadingCone && map) {
            map.removeLayer(userHeadingCone);
            userHeadingCone = null;
        }

        return;
    }

    const coneLength = 60;
    const coneHalfAngle = 20;
    const leftPoint = destinationPoint(
        currentUserLocation.lat,
        currentUserLocation.lon,
        coneLength,
        heading - coneHalfAngle
    );
    const rightPoint = destinationPoint(
        currentUserLocation.lat,
        currentUserLocation.lon,
        coneLength,
        heading + coneHalfAngle
    );

    const coneCoordinates = [
        [currentUserLocation.lat, currentUserLocation.lon],
        leftPoint,
        rightPoint
    ];

    if (!userHeadingCone) {
        userHeadingCone = L.polygon(coneCoordinates, {
            color: "#2563eb",
            weight: 1,
            opacity: 0.35,
            fillColor: "#60a5fa",
            fillOpacity: 0.25,
            interactive: false
        }).addTo(map);
    } else {
        userHeadingCone.setLatLngs(coneCoordinates);
    }
}


function findClosestRoutePoint(location) {
    if (!routeLine) {
        return null;
    }

    const routePoints = routeLine.getLatLngs();

    if (!Array.isArray(routePoints) || routePoints.length < 2) {
        return null;
    }

    let cumulativeDistance = 0;
    let closest = null;

    for (let index = 0; index < routePoints.length - 1; index++) {
        const pointA = routePoints[index];
        const pointB = routePoints[index + 1];
        const latScale = 111320;
        const lonScale = 111320 * Math.cos(pointA.lat * Math.PI / 180);
        const segmentX = (pointB.lng - pointA.lng) * lonScale;
        const segmentY = (pointB.lat - pointA.lat) * latScale;
        const userX = (location.lon - pointA.lng) * lonScale;
        const userY = (location.lat - pointA.lat) * latScale;
        const segmentSquared = segmentX * segmentX + segmentY * segmentY;
        const projection = segmentSquared === 0
            ? 0
            : Math.max(0, Math.min(1, (userX * segmentX + userY * segmentY) / segmentSquared));
        const closestX = projection * segmentX;
        const closestY = projection * segmentY;
        const offsetX = userX - closestX;
        const offsetY = userY - closestY;
        const segmentDistance = Math.sqrt(segmentX * segmentX + segmentY * segmentY);
        const pointDistance = Math.sqrt(offsetX * offsetX + offsetY * offsetY);

        if (!closest || pointDistance < closest.distance) {
            closest = {
                distance: pointDistance,
                distanceAlongRoute: cumulativeDistance + segmentDistance * projection,
                point: {
                    lat: pointA.lat + (pointB.lat - pointA.lat) * projection,
                    lon: pointA.lng + (pointB.lng - pointA.lng) * projection
                }
            };
        }

        cumulativeDistance += segmentDistance;
    }

    return closest;
}


function updateArrivalState(destinationDistance) {
    let nextState = null;

    if (destinationDistance <= 30) {
        nextState = "reached";
    } else if (destinationDistance <= 50) {
        nextState = "nearby";
    } else if (destinationDistance <= 100) {
        nextState = "approaching";
    }

    if (nextState && nextState !== arrivalState) {
        arrivalState = nextState;

        const messages = {
            approaching: "You are near the destination",
            nearby: "Destination nearby",
            reached: "You have reached the destination"
        };

        setNavigationText("navigationDestination", messages[nextState]);
    } else if (nextState) {
        const messages = {
            approaching: "You are near the destination",
            nearby: "Destination nearby",
            reached: "You have reached the destination"
        };

        setNavigationText("navigationDestination", messages[nextState]);
    } else if (!nextState && arrivalState === null) {
        setNavigationText(
            "navigationDestination",
            `Distance to destination: ${formatDistance(destinationDistance)}`
        );
    }
}


function updateNavigationForLocation() {
    if (!currentUserLocation) {
        return;
    }

    const destinationDistance = currentRouteEnd
        ? distanceBetweenPoints(
            currentUserLocation.lat,
            currentUserLocation.lon,
            currentRouteEnd.lat,
            currentRouteEnd.lon
        )
        : null;

    setNavigationText(
        "navigationDestination",
        destinationDistance === null
            ? "Distance to destination: --"
            : `Distance to destination: ${formatDistance(destinationDistance)}`
    );

    if (destinationDistance !== null) {
        updateArrivalState(destinationDistance);
    }

    const closestRoutePoint = findClosestRoutePoint(currentUserLocation);

    if (!closestRoutePoint || !routeLine) {
        setNavigationText("navigationRouteStatus", "Route status: Waiting for route");
        setNavigationText("navigationDistance", "0 km completed");
        setNavigationText("navigationRemaining", "-- km remaining");
        return;
    }

    const totalRouteDistance = routeLine.getLatLngs().slice(1).reduce((total, point, index) => {
        const previousPoint = routeLine.getLatLngs()[index];
        return total + distanceBetweenPoints(previousPoint.lat, previousPoint.lng, point.lat, point.lng);
    }, 0);

    routeDistanceCompleted = Math.max(0, Math.min(totalRouteDistance, closestRoutePoint.distanceAlongRoute));
    routeDistanceRemaining = Math.max(0, totalRouteDistance - routeDistanceCompleted);
    distanceFromRoute = closestRoutePoint.distance;
    routeProgressPercentage = totalRouteDistance > 0
        ? Math.max(0, Math.min(100, routeDistanceCompleted / totalRouteDistance * 100))
        : 0;

    const routeStatusElement = document.getElementById("navigationRouteStatus");
    const routeStatus = distanceFromRoute > 500
        ? isOffline ? "⚠️ Off route — automatic rerouting unavailable offline" : "⚠️ You are far from the planned route"
        : distanceFromRoute > 200
            ? isOffline ? "⚠️ Off route — automatic rerouting unavailable offline" : "⚠️ Off route"
            : "✓ On route";

    setNavigationText("navigationRouteStatus", `Route status: ${routeStatus} (${formatDistance(distanceFromRoute)} away)`);

    if (routeStatusElement) {
        routeStatusElement.classList.toggle("is-off-route", distanceFromRoute > 200 && distanceFromRoute <= 500);
        routeStatusElement.classList.toggle("is-far-off-route", distanceFromRoute > 500);
    }

    setNavigationText("navigationProgress", `${routeProgressPercentage.toFixed(1)}%`);
    setNavigationText("navigationDistance", `${formatDistance(routeDistanceCompleted)} completed`);
    setNavigationText("navigationRemaining", `${formatDistance(routeDistanceRemaining)} remaining`);

    const progressBar = document.getElementById("navigationProgressBar");
    if (progressBar) {
        progressBar.style.width = `${routeProgressPercentage}%`;
    }
}


function updateUserLocation(position) {
    const latitude = Number(position?.coords?.latitude);
    const longitude = Number(position?.coords?.longitude);
    const accuracy = Number(position?.coords?.accuracy);

    if (!Number.isFinite(latitude) || !Number.isFinite(longitude)) {
        handleLocationError({ code: 2 });
        return;
    }

    currentUserLocation = { lat: latitude, lon: longitude };
    currentGpsAccuracy = Number.isFinite(accuracy) ? Math.max(0, accuracy) : null;

    if (!userLocationMarker) {
        userLocationMarker = createUserLocationMarker();
    } else {
        userLocationMarker.setLatLng([latitude, longitude]);
    }

    if (!userAccuracyCircle) {
        userAccuracyCircle = L.circle([latitude, longitude], {
            radius: currentGpsAccuracy || 0,
            color: "#60a5fa",
            weight: 1,
            opacity: 0.6,
            fillColor: "#93c5fd",
            fillOpacity: 0.16,
            interactive: false
        }).addTo(map);
    } else {
        userAccuracyCircle.setLatLng([latitude, longitude]);
        userAccuracyCircle.setRadius(currentGpsAccuracy || 0);
    }

    updateUserHeadingCone();
    setNavigationText("navigationStatus", "GPS: Active");
    setNavigationText("gpsAccuracy", `±${currentGpsAccuracy === null ? "--" : Math.round(currentGpsAccuracy)} m`);
    setNavigationText("gpsCoordinates", `${latitude.toFixed(5)}, ${longitude.toFixed(5)}`);
    updateNavigationForLocation();

    if (!hasCenteredOnLiveLocation) {
        map.setView([latitude, longitude], map.getZoom());
        hasCenteredOnLiveLocation = true;
    } else if (followUserMode) {
        map.panTo([latitude, longitude], { animate: true, duration: 0.25 });
    }
}


function handleLocationError(error) {
    const messages = {
        1: "Location permission denied.",
        2: "Unable to determine your current location.",
        3: "GPS request timed out. Retrying..."
    };

    setNavigationText("navigationStatus", messages[error?.code] || "Unable to get your location.");
}


function startLiveLocation() {
    if (!navigator.geolocation) {
        setNavigationText("navigationStatus", "Live GPS is unavailable on this device/browser.");
        return;
    }

    if (gpsWatchId !== null) {
        return;
    }

    hasCenteredOnLiveLocation = false;
    setNavigationText("navigationStatus", "GPS: Waiting...");

    try {
        gpsWatchId = navigator.geolocation.watchPosition(
            updateUserLocation,
            handleLocationError,
            {
                enableHighAccuracy: true,
                maximumAge: 3000,
                timeout: 10000
            }
        );
    } catch (error) {
        console.error("Unable to start live GPS:", error);
        setNavigationText("navigationStatus", "Live GPS is unavailable on this device/browser.");
        gpsWatchId = null;
        return;
    }

    const startButton = document.getElementById("startLiveLocationBtn");
    const stopButton = document.getElementById("stopLiveLocationBtn");
    const followButton = document.getElementById("followUserBtn");

    if (startButton) startButton.hidden = true;
    if (stopButton) stopButton.hidden = false;
    if (followButton) followButton.disabled = false;
}


function stopLiveLocation() {
    if (gpsWatchId !== null && navigator.geolocation) {
        navigator.geolocation.clearWatch(gpsWatchId);
    }

    gpsWatchId = null;
    currentUserLocation = null;
    currentGpsAccuracy = null;
    hasCenteredOnLiveLocation = false;

    [userLocationMarker, userAccuracyCircle, userHeadingCone].forEach(layer => {
        if (layer && map) {
            map.removeLayer(layer);
        }
    });

    userLocationMarker = null;
    userAccuracyCircle = null;
    userHeadingCone = null;
    followUserMode = false;

    setNavigationText("navigationStatus", "GPS: Off");
    setNavigationText("gpsAccuracy", "--");
    setNavigationText("gpsCoordinates", "--");

    const startButton = document.getElementById("startLiveLocationBtn");
    const stopButton = document.getElementById("stopLiveLocationBtn");
    const followButton = document.getElementById("followUserBtn");

    if (startButton) startButton.hidden = false;
    if (stopButton) stopButton.hidden = true;
    if (followButton) {
        followButton.disabled = true;
        followButton.textContent = "Follow Me";
    }
}


function resetNavigationState() {
    routeDistanceCompleted = 0;
    routeDistanceRemaining = null;
    distanceFromRoute = null;
    routeProgressPercentage = 0;
    arrivalState = null;

    setNavigationText("navigationProgress", "0%");
    setNavigationText("navigationDistance", "0 km completed");
    setNavigationText("navigationRemaining", "-- km remaining");
    setNavigationText("navigationRouteStatus", "Route status: Waiting for route");
    setNavigationText("navigationDestination", "Distance to destination: --");

    const progressBar = document.getElementById("navigationProgressBar");
    const routeStatusElement = document.getElementById("navigationRouteStatus");

    if (progressBar) progressBar.style.width = "0%";
    if (routeStatusElement) {
        routeStatusElement.classList.remove("is-off-route", "is-far-off-route");
    }
}


const startLiveLocationButton = document.getElementById("startLiveLocationBtn");
const stopLiveLocationButton = document.getElementById("stopLiveLocationBtn");
const followUserButton = document.getElementById("followUserBtn");

if (startLiveLocationButton) startLiveLocationButton.addEventListener("click", startLiveLocation);
if (stopLiveLocationButton) stopLiveLocationButton.addEventListener("click", stopLiveLocation);
if (followUserButton) {
    followUserButton.addEventListener("click", () => {
        followUserMode = !followUserMode;
        followUserButton.textContent = followUserMode ? "Following" : "Follow Me";

        if (followUserMode && currentUserLocation) {
            map.panTo([currentUserLocation.lat, currentUserLocation.lon], {
                animate: true,
                duration: 0.25
            });
        }
    });
}


// =========================
// WEATHER DESCRIPTION
// =========================

function getWeatherDescription(code) {
    const descriptions = {
        0: "Clear sky",
        1: "Mainly clear",
        2: "Partly cloudy",
        3: "Overcast",
        45: "Fog",
        48: "Rime fog",
        51: "Light drizzle",
        53: "Moderate drizzle",
        55: "Dense drizzle",
        61: "Slight rain",
        63: "Moderate rain",
        65: "Heavy rain",
        71: "Slight snow",
        73: "Moderate snow",
        75: "Heavy snow",
        80: "Slight rain showers",
        81: "Moderate rain showers",
        82: "Heavy rain showers",
        95: "Thunderstorm",
        96: "Thunderstorm with hail",
        99: "Heavy thunderstorm with hail"
    };

    return descriptions[code] || "Unknown weather";
}


// ============================================================
// GET WEATHER FROM OPEN-METEO
// ============================================================

async function getWeather(latitude, longitude) {

    const url =
        "https://api.open-meteo.com/v1/forecast" +
        "?latitude=" + encodeURIComponent(latitude) +
        "&longitude=" + encodeURIComponent(longitude) +
        "&current=temperature_2m,relative_humidity_2m,precipitation,weather_code,wind_speed_10m" +
        "&hourly=precipitation_probability,rain,weather_code,temperature_2m,wind_speed_10m" +
        "&forecast_hours=24" +
        "&timezone=auto";

    console.log("Weather request:", url);

    try {

        const response = await fetch(url);

        console.log(
            "Weather API status:",
            response.status
        );

        if (!response.ok) {

            throw new Error(
                "Weather API returned HTTP " +
                response.status
            );
        }

        const data = await response.json();

        console.log(
            "Weather data received:",
            data
        );

        return data;

    } catch (error) {

        console.error(
            "WEATHER API ERROR:",
            error
        );

        return null;
    }
}


// ============================================================
// ROUTE WEATHER MANAGEMENT
// ============================================================

function getRouteWeatherPoints(routeCoordinates) {
    if (!Array.isArray(routeCoordinates) || routeCoordinates.length < 2) {
        return [];
    }

    const pointCount = routeCoordinates.length > 250 ? 8 : 5;
    const positions = pointCount === 8
        ? [0, 0.125, 0.25, 0.375, 0.5, 0.625, 0.75, 1]
        : [0, 0.25, 0.5, 0.75, 1];

    return positions.map((fraction, index) => {
        const routeIndex = Math.min(
            routeCoordinates.length - 1,
            Math.round(fraction * (routeCoordinates.length - 1))
        );
        const point = routeCoordinates[routeIndex];
        const isStart = index === 0;
        const isDestination = index === positions.length - 1;

        return {
            latitude: Number(point.lat),
            longitude: Number(point.lng),
            routePosition: isStart
                ? "Start"
                : isDestination
                    ? "Destination"
                    : `${Math.round(fraction * 100)}% Route`,
            fraction
        };
    }).filter(point => Number.isFinite(point.latitude) && Number.isFinite(point.longitude));
}


function getTravelTimeWeather(weatherData, routeDuration, routeFraction = 0) {
    if (!weatherData || !weatherData.hourly || !Array.isArray(weatherData.hourly.time)) {
        return null;
    }

    const hourly = weatherData.hourly;
    const targetTime = Date.now() + Math.max(0, routeDuration || 0) * routeFraction * 1000;
    let closestIndex = 0;
    let closestDifference = Infinity;

    hourly.time.forEach((time, index) => {
        const difference = Math.abs(new Date(time).getTime() - targetTime);

        if (Number.isFinite(difference) && difference < closestDifference) {
            closestDifference = difference;
            closestIndex = index;
        }
    });

    const valueAt = key => Array.isArray(hourly[key]) ? hourly[key][closestIndex] : null;

    return {
        temperature: valueAt("temperature_2m"),
        precipitationProbability: valueAt("precipitation_probability"),
        rain: valueAt("rain"),
        windSpeed: valueAt("wind_speed_10m"),
        weatherCode: valueAt("weather_code"),
        forecastTime: hourly.time[closestIndex]
    };
}


function isSevereWeather(weatherCode) {
    return [65, 67, 75, 82, 95, 96, 99].includes(Number(weatherCode));
}


function removeRouteWeatherMarkers() {
    routeWeatherMarkers.forEach(marker => {
        if (map && map.hasLayer(marker)) {
            map.removeLayer(marker);
        }
    });

    routeWeatherMarkers = [];
}


function getWeatherMarkerIcon(weatherPoint) {
    const code = Number(weatherPoint.weatherCode);
    const icon = isSevereWeather(code)
        ? "⛈️"
        : code >= 51 && code <= 82
            ? "🌧️"
            : code >= 1 && code <= 3
                ? "🌤️"
                : "☀️";

    return L.divIcon({
        className: "route-weather-marker",
        html: `<span>${icon}</span><small>${weatherPoint.position}</small>`,
        iconSize: [58, 26],
        iconAnchor: [29, 13]
    });
}


function showRouteWeatherMarkers(routeWeather) {
    removeRouteWeatherMarkers();

    if (!map || !routeWeather?.points) {
        return;
    }

    routeWeather.points.forEach(weatherPoint => {
        const marker = L.marker(
            [weatherPoint.latitude, weatherPoint.longitude],
            {
                icon: getWeatherMarkerIcon(weatherPoint),
                interactive: false,
                zIndexOffset: 100
            }
        ).addTo(map);

        routeWeatherMarkers.push(marker);
    });
}


function generateRouteWeatherSummary(routeWeather) {
    const points = routeWeather?.points || [];

    if (!points.length) {
        return "Route weather is temporarily unavailable.";
    }

    const first = points[0];
    const last = points[points.length - 1];
    const maxProbability = Math.max(...points.map(point => Number(point.precipitationProbability) || 0));
    const maxRain = Math.max(...points.map(point => Number(point.rain) || 0));
    const severePoint = points.find(point => isSevereWeather(point.weatherCode));
    const probabilityIncrease = Number(last.precipitationProbability || 0) - Number(first.precipitationProbability || 0);

    if (severePoint) {
        return `${getWeatherDescription(severePoint.weatherCode)} conditions detected near ${severePoint.position.toLowerCase()}.`;
    }

    if (probabilityIncrease >= 20) {
        return "Rain probability increases along the route.";
    }

    if (maxRain >= 5) {
        return "Higher rainfall conditions are forecast along part of the route.";
    }

    if (maxProbability >= 60) {
        return "Weather conditions may change during the journey.";
    }

    if (Math.abs(Number(last.temperature) - Number(first.temperature)) >= 5) {
        return "Temperature varies significantly along the route.";
    }

    return "Weather remains mostly stable along the route.";
}


function getRouteWeatherWarning(routeWeather) {
    const points = routeWeather?.points || [];
    const severePoint = points.find(point => isSevereWeather(point.weatherCode));

    if (severePoint) {
        return `⛈️ WEATHER WARNING: ${getWeatherDescription(severePoint.weatherCode)} conditions detected near ${severePoint.position.toLowerCase()}.`;
    }

    const wetPoint = points.reduce((highest, point) =>
        Number(point.precipitationProbability || 0) > Number(highest?.precipitationProbability || 0) ? point : highest,
    null);

    if (wetPoint && Number(wetPoint.precipitationProbability) >= 60) {
        return `⚠️ WEATHER WARNING: Rain probability increases to ${Math.round(wetPoint.precipitationProbability)}% around ${wetPoint.position.toLowerCase()}.`;
    }

    if (wetPoint && Number(wetPoint.rain) >= 5) {
        return `⚠️ WEATHER WARNING: Higher rainfall conditions are forecast near ${wetPoint.position.toLowerCase()}.`;
    }

    return "";
}


function showWeatherCard(routeWeather = routeWeatherData, loading = false) {
    const oldCard = document.getElementById("weatherCard");
    if (oldCard) oldCard.remove();

    if (loading) {
        routeWeatherLoading = true;
        const weatherBody = document.getElementById("dashboardWeatherBody");
        if (weatherBody) weatherBody.innerHTML = "<span class=\"dashboard-loading\">🌦️ Updating route weather...</span>";
    } else {
        routeWeatherLoading = false;
    }

    updateSmartRouteDashboard();
}


function summaryTemperature(summary, routeWeather) {
    if (!Number.isFinite(summary?.minTemperature) || !Number.isFinite(summary?.maxTemperature)) {
        return "--";
    }

    return `${summary.minTemperature.toFixed(0)}–${summary.maxTemperature.toFixed(0)}°C`;
}


function buildRouteWeatherModel(points, weatherResponses, routeDuration = currentRouteDurationSeconds) {
    const weatherPoints = points.map((point, index) => {
        const response = weatherResponses[index];
        const travelWeather = getTravelTimeWeather(response, routeDuration, point.fraction);
        const current = response?.current || {};
        const selected = travelWeather || {
            temperature: current.temperature_2m,
            precipitationProbability: null,
            rain: current.precipitation,
            windSpeed: current.wind_speed_10m,
            weatherCode: current.weather_code
        };

        if (!response || !selected) return null;

        return {
            position: point.routePosition,
            latitude: point.latitude,
            longitude: point.longitude,
            temperature: selected.temperature,
            humidity: current.relative_humidity_2m,
            precipitation: current.precipitation,
            precipitationProbability: selected.precipitationProbability,
            rain: selected.rain ?? current.precipitation,
            windSpeed: selected.windSpeed ?? current.wind_speed_10m,
            weatherCode: selected.weatherCode ?? current.weather_code,
            description: getWeatherDescription(selected.weatherCode ?? current.weather_code)
        };
    }).filter(Boolean);

    const temperatures = weatherPoints.map(point => Number(point.temperature)).filter(Number.isFinite);
    const probabilities = weatherPoints.map(point => Number(point.precipitationProbability)).filter(Number.isFinite);
    const rainfall = weatherPoints.map(point => Number(point.rain)).filter(Number.isFinite);
    const wind = weatherPoints.map(point => Number(point.windSpeed)).filter(Number.isFinite);

    return {
        points: weatherPoints,
        summary: {
            minTemperature: temperatures.length ? Math.min(...temperatures) : null,
            maxTemperature: temperatures.length ? Math.max(...temperatures) : null,
            maximumRainProbability: probabilities.length ? Math.max(...probabilities) : 0,
            maximumRainfall: rainfall.length ? Math.max(...rainfall) : 0,
            maximumWindSpeed: wind.length ? Math.max(...wind) : 0,
            severeWeatherDetected: weatherPoints.some(point => isSevereWeather(point.weatherCode))
        }
    };
}


async function getCachedWeather(latitude, longitude) {
    const key = `${Number(latitude).toFixed(4)},${Number(longitude).toFixed(4)}`;
    if (!routeWeatherCache.has(key)) {
        routeWeatherCache.set(key, getWeather(latitude, longitude));
    }
    return routeWeatherCache.get(key);
}


async function fetchRouteWeatherForCoordinates(routeCoordinates, routeDuration) {
    const points = getRouteWeatherPoints(routeCoordinates.map(([lat, lng]) => ({ lat, lng })));
    if (!points.length) return null;

    const responses = [];
    for (const point of points) {
        responses.push(await getCachedWeather(point.latitude, point.longitude));
    }

    const model = buildRouteWeatherModel(points, responses, routeDuration);
    return model.points.length ? model : null;
}


async function fetchRouteWeather() {
    if (!routeLine) return null;

    const requestId = ++routeWeatherRequestId;
    const points = getRouteWeatherPoints(routeLine.getLatLngs());

    if (!points.length) return null;

    showWeatherCard(null, true);
    const responses = [];

    for (const point of points) {
        responses.push(await getCachedWeather(point.latitude, point.longitude));
    }

    if (requestId !== routeWeatherRequestId) return null;

    const model = buildRouteWeatherModel(points, responses, currentRouteDurationSeconds);
    routeWeatherData = model.points.length ? model : null;
    showWeatherCard(routeWeatherData);
    showRouteWeatherMarkers(routeWeatherData);
    return routeWeatherData;
}


async function refreshRouteWeather() {
    if (!routeLine) return;
    if (isOffline) {
        updateNetworkStatus("Offline: using cached weather intelligence");
        return;
    }
    invalidateAiRouteIntelligence();

    await fetchRouteWeather();
    const nearbyIssues = getNearbyRouteIssues(currentActiveIssues);
    const activeOption = currentRouteOptions[activeRouteOptionIndex];
    if (activeOption) {
        activeOption.weatherData = routeWeatherData;
        activeOption.weather = routeWeatherData ? getWeatherStatus(routeWeatherData) : "Unavailable";
        activeOption.nearbyIssues = nearbyIssues;
        activeOption.issueCounts = getIssueTypeCounts(nearbyIssues);
        activeOption.risk = calculateRouteRisk(null, null, nearbyIssues, routeWeatherData, routeTerrainData);
        activeOption.riskScore = activeOption.risk.score;
        activeOption.riskLevel = activeOption.risk.level;
        activeOption.riskReasons = activeOption.risk.reasons;
        updateRouteOptionHazards(activeOption);
        showActiveHazardMarkers(activeOption);
        saveRouteSnapshot();
    }
    showRouteRiskCard(calculateRouteRisk(null, null, nearbyIssues, routeWeatherData, routeTerrainData));
}


// ============================================================
// ROUTE RISK INTELLIGENCE
// ============================================================

function removeRouteRiskCard() {
    const oldCard = document.getElementById("routeRiskCard");
    if (oldCard) {
        oldCard.remove();
    }
}


function getRiskLevel(score) {
    if (score <= 29) return "LOW";
    if (score <= 59) return "MODERATE";
    return "HIGH";
}


function calculateRouteRisk(startWeather, endWeather, nearbyIssues = [], routeWeather = null, terrainData = null) {
    let score = 0;
    const reasons = [];

    const startCurrent = startWeather?.current || {};
    const endCurrent = endWeather?.current || {};

    const hourlyStart = startWeather?.hourly || {};
    const hourlyEnd = endWeather?.hourly || {};

    const precipitationProbabilities = [
        ...(Array.isArray(hourlyStart.precipitation_probability) ? hourlyStart.precipitation_probability : []),
        ...(Array.isArray(hourlyEnd.precipitation_probability) ? hourlyEnd.precipitation_probability : [])
    ];

    const forecastRain = [
        ...(Array.isArray(hourlyStart.rain) ? hourlyStart.rain : []),
        ...(Array.isArray(hourlyEnd.rain) ? hourlyEnd.rain : [])
    ];

    const weatherCodes = [
        startCurrent.weather_code,
        endCurrent.weather_code,
        ...(Array.isArray(hourlyStart.weather_code) ? hourlyStart.weather_code : []),
        ...(Array.isArray(hourlyEnd.weather_code) ? hourlyEnd.weather_code : [])
    ].filter(value => value !== undefined && value !== null);

    const routeWeatherPoints = routeWeather?.points || [];
    precipitationProbabilities.push(
        ...routeWeatherPoints
            .map(point => point.precipitationProbability)
            .filter(value => value !== undefined && value !== null)
    );
    forecastRain.push(
        ...routeWeatherPoints
            .map(point => point.rain)
            .filter(value => value !== undefined && value !== null)
    );
    weatherCodes.push(
        ...routeWeatherPoints
            .map(point => point.weatherCode)
            .filter(value => value !== undefined && value !== null)
    );

    const currentPrecipitation = Math.max(
        Number(startCurrent.precipitation || 0),
        Number(endCurrent.precipitation || 0),
        ...routeWeatherPoints.map(point => Number(point.precipitation || 0))
    );

    const maxProbability = precipitationProbabilities.length
        ? Math.max(...precipitationProbabilities.map(value => Number(value || 0)))
        : 0;

    const maxRainForecast = forecastRain.length
        ? Math.max(...forecastRain.map(value => Number(value || 0)))
        : 0;

    const currentPrecipThresholds = [
        { max: 0, points: 0, reason: null },
        { max: 2, points: 5, reason: "Current precipitation detected" },
        { max: 5, points: 10, reason: "Moderate precipitation" },
        { max: 10, points: 20, reason: "High precipitation" },
        { max: Infinity, points: 30, reason: "Very high precipitation" }
    ];

    const currentPrecipRule = currentPrecipThresholds.find(item => currentPrecipitation > (item.max === Infinity ? 0 : item.max) && currentPrecipitation <= (item.max === Infinity ? Number.MAX_SAFE_INTEGER : item.max));

    if (currentPrecipRule && currentPrecipRule.reason) {
        score += currentPrecipRule.points;
        reasons.push(currentPrecipRule.reason);
    }

    const probabilityThresholds = [
        { max: 29, points: 0, reason: null },
        { max: 60, points: 5, reason: "High precipitation probability" },
        { max: 80, points: 10, reason: "Elevated precipitation probability" },
        { max: Infinity, points: 15, reason: "Very high precipitation probability" }
    ];

    const probabilityRule = probabilityThresholds.find(item => maxProbability > item.max);
    if (probabilityRule && probabilityRule.reason) {
        score += probabilityRule.points;
        reasons.push(probabilityRule.reason);
    }

    const rainThresholds = [
        { max: 2, points: 0, reason: null },
        { max: 5, points: 5, reason: "Light rainfall forecast" },
        { max: 10, points: 10, reason: "Moderate rainfall forecast" },
        { max: Infinity, points: 20, reason: "Heavy rainfall forecast" }
    ];

    const rainRule = rainThresholds.find(item => maxRainForecast > item.max);
    if (rainRule && rainRule.reason) {
        score += rainRule.points;
        reasons.push(rainRule.reason);
    }

    const hasThunderstorm = weatherCodes.some(code => [95, 96, 99].includes(Number(code)));
    if (hasThunderstorm) {
        score += 15;
        reasons.push("Thunderstorm conditions detected");
    }

    const heavyRainCodes = [65, 82, 95];
    const hasHeavyRain = weatherCodes.some(code => heavyRainCodes.includes(Number(code)));
    if (hasHeavyRain) {
        score += 10;
        reasons.push("Heavy rain conditions detected");
    }

    if (terrainData?.difficulty === "STEEP") {
        score += 5;
        reasons.push("Steep terrain section detected");
    } else if (terrainData?.difficulty === "VERY STEEP") {
        score += 10;
        reasons.push("Very steep terrain section detected");
    }

    const steepRainOverlap = terrainData?.summary?.maximumSlope > 6 &&
        routeWeatherPoints.some(point => Number(point.precipitationProbability || 0) >= 60);
    if (steepRainOverlap) {
        reasons.push("Steep terrain with rainfall forecast");
    }

    const issueWeights = {
        "Road Block": 25,
        "Accident": 20,
        "Flood": 30,
        "Landslide": 30,
        "Traffic": 10,
        "Road Damage": 10
    };

    const issueMessages = {
        "Road Block": "Road block reported near route",
        "Accident": "Accident reported near route",
        "Flood": "Flood report near route",
        "Landslide": "Landslide report near route",
        "Traffic": "Traffic issue near route",
        "Road Damage": "Road damage report near route"
    };

    const seenIssues = new Set();

    nearbyIssues.forEach(issue => {
        const key = issue.id || `${issue.issue_type}-${issue.latitude}-${issue.longitude}`;
        if (seenIssues.has(key)) {
            return;
        }

        seenIssues.add(key);

        const issueType = issue.issue_type;
        const issueScore = issueWeights[issueType] || 0;

        if (issueScore > 0) {
            score += issueScore;
            reasons.push(issueMessages[issueType] || "Reported road issue near route");
        }
    });

    score = Math.min(score, 100);

    const uniqueReasons = [...new Set(reasons)];

    return {
        score,
        level: getRiskLevel(score),
        reasons: uniqueReasons
    };
}


function showRouteRiskCard(risk) {
    removeRouteRiskCard();
    currentRouteRisk = risk || null;
    updateSmartRouteDashboard();
}


function getNearbyRouteIssues(issues = []) {
    return getNearbyIssuesForRoute(routeLine?.getLatLngs(), issues);
}


function getNearbyIssuesForRoute(routeLatLngs, issues = []) {
    if (!Array.isArray(routeLatLngs) || routeLatLngs.length < 2 || !Array.isArray(issues)) {
        return [];
    }

    const routePoints = routeLatLngs.map(point => Array.isArray(point)
        ? { lat: point[0], lng: point[1] }
        : point);

    return issues.filter(issue => {
        if (!issue || !issue.latitude || !issue.longitude) {
            return false;
        }

        const issueLat = parseFloat(issue.latitude);
        const issueLon = parseFloat(issue.longitude);

        let nearestDistance = Infinity;

        for (let i = 0; i < routePoints.length - 1; i++) {
            const pointA = routePoints[i];
            const pointB = routePoints[i + 1];

            const latScale = 111320;
            const lonScale = 111320 * Math.cos(pointA.lat * Math.PI / 180);

            const bx = (pointB.lng - pointA.lng) * lonScale;
            const by = (pointB.lat - pointA.lat) * latScale;
            const px = (issueLon - pointA.lng) * lonScale;
            const py = (issueLat - pointA.lat) * latScale;

            const segmentSquared = bx * bx + by * by;

            let t = 0;
            if (segmentSquared !== 0) {
                t = (px * bx + py * by) / segmentSquared;
            }

            t = Math.max(0, Math.min(1, t));

            const closestX = t * bx;
            const closestY = t * by;
            const dx = px - closestX;
            const dy = py - closestY;
            const distance = Math.sqrt(dx * dx + dy * dy);

            if (distance < nearestDistance) {
                nearestDistance = distance;
            }
        }

        return nearestDistance <= 2000;
    });
}


// These thresholds describe indicators from currently available observations;
// they are not calibrated disaster-warning or prediction thresholds.
const HAZARD_THRESHOLDS = {
    rainfallMm: 5,
    precipitationProbability: 60,
    steepSlopePercent: 6,
    verySteepSlopePercent: 10,
    largeElevationVariationMeters: 300
};


function getRouteSectionLabel(point) {
    if (!point) return null;
    if (point.routePosition) {
        return point.routePosition === "Destination"
            ? "Near destination"
            : point.routePosition === "Start"
                ? "Near start"
                : `Near ${point.routePosition}`;
    }
    if (Number.isFinite(Number(point.fraction))) {
        return `Near ${Math.round(Number(point.fraction) * 100)}% of route`;
    }
    return null;
}


function getWeatherHazardPoints(routeWeather) {
    return routeWeather?.points?.filter(point =>
        Number(point.rain || 0) >= HAZARD_THRESHOLDS.rainfallMm ||
        Number(point.precipitationProbability || 0) >= HAZARD_THRESHOLDS.precipitationProbability ||
        isSevereWeather(point.weatherCode)
    ) || [];
}


function hasReportedFloodIssue(routeIssues = []) {
    return routeIssues.some(issue => issue.issue_type === "Flood");
}


function hasReportedLandslideIssue(routeIssues = []) {
    return routeIssues.some(issue => issue.issue_type === "Landslide");
}


function isSteepTerrainSection(terrainData) {
    return Number(terrainData?.summary?.maximumSlope || 0) >= HAZARD_THRESHOLDS.steepSlopePercent;
}


function getIndicatorLevel(score) {
    if (score >= 60) return "HIGH";
    if (score >= 30) return "MODERATE";
    return "LOW";
}


function getIndicatorConfidence(routeWeather, terrainData, routeIssues) {
    const weatherAvailable = Boolean(routeWeather?.points?.length);
    const terrainAvailable = Boolean(terrainData?.points?.length);
    const incidentsAvailable = roadIssuesDataAvailable && Array.isArray(routeIssues);
    return weatherAvailable && terrainAvailable && incidentsAvailable ? "MODERATE" : "LOW";
}


function uniqueSections(sections) {
    return [...new Set(sections.filter(Boolean))];
}


function calculateFloodIndicator(routeWeather, terrainData, routeIssues = []) {
    const factors = [];
    const affectedSections = [];
    const weatherPoints = getWeatherHazardPoints(routeWeather);
    const rainfallPoints = routeWeather?.points?.filter(point => Number(point.rain || 0) >= HAZARD_THRESHOLDS.rainfallMm) || [];
    const probabilityPoints = routeWeather?.points?.filter(point => Number(point.precipitationProbability || 0) >= HAZARD_THRESHOLDS.precipitationProbability) || [];
    let score = 0;

    if (rainfallPoints.length) {
        score += 30;
        factors.push("High rainfall forecast");
        affectedSections.push(...rainfallPoints.map(getRouteSectionLabel));
    }
    if (probabilityPoints.length) {
        score += 20;
        factors.push("High precipitation probability");
        affectedSections.push(...probabilityPoints.map(getRouteSectionLabel));
    }
    if (weatherPoints.some(point => isSevereWeather(point.weatherCode))) {
        score += 15;
        factors.push("Heavy precipitation detected along route");
        affectedSections.push(...weatherPoints.filter(point => isSevereWeather(point.weatherCode)).map(getRouteSectionLabel));
    }
    if (terrainData?.summary?.elevationDifference >= HAZARD_THRESHOLDS.largeElevationVariationMeters && weatherPoints.length) {
        score += 5;
        factors.push("Elevation variation along route");
    }
    if (hasReportedFloodIssue(routeIssues)) {
        score += 40;
        factors.push("Reported flood issue near route");
        affectedSections.push("Near reported incident");
    }

    if (!routeWeather?.points?.length) {
        factors.push("Insufficient weather data");
    }

    if (!factors.length) {
        factors.push("No significant flood-related indicators detected from currently available data.");
    }

    return {
        level: getIndicatorLevel(Math.min(score, 100)),
        score: Math.min(score, 100),
        factors,
        affectedSections: uniqueSections(affectedSections),
        confidence: getIndicatorConfidence(routeWeather, terrainData, routeIssues)
    };
}


function calculateLandslideIndicator(routeWeather, terrainData, routeIssues = []) {
    const factors = [];
    const affectedSections = [];
    const weatherPoints = getWeatherHazardPoints(routeWeather);
    const summary = terrainData?.summary;
    let score = 0;

    if (Number(summary?.maximumSlope || 0) >= HAZARD_THRESHOLDS.verySteepSlopePercent) {
        score += 25;
        factors.push("Very steep terrain section");
        affectedSections.push(getRouteSectionLabel(terrainData.points.find(point => point.isSteepest)));
    } else if (isSteepTerrainSection(terrainData)) {
        score += 15;
        factors.push("Steep terrain section");
        affectedSections.push(getRouteSectionLabel(terrainData.points.find(point => point.isSteepest)));
    }
    if (Number(summary?.elevationDifference || 0) >= HAZARD_THRESHOLDS.largeElevationVariationMeters) {
        score += 5;
        factors.push("Large elevation variation along route");
    }
    if (weatherPoints.length) {
        score += weatherPoints.some(point => Number(point.rain || 0) >= HAZARD_THRESHOLDS.rainfallMm) ? 25 : 15;
        factors.push("Steep terrain with rainfall conditions detected.");
        affectedSections.push(...weatherPoints.map(getRouteSectionLabel));
    }
    if (hasReportedLandslideIssue(routeIssues)) {
        score += 40;
        factors.push("Reported landslide issue near route");
        affectedSections.push("Near reported incident");
    }

    if (!terrainData?.points?.length) {
        factors.push("Insufficient terrain data");
    }
    if (!routeWeather?.points?.length) {
        factors.push("Insufficient weather data");
    }

    if (!factors.length) {
        factors.push("No significant landslide-related indicators detected from currently available data.");
    }

    return {
        level: getIndicatorLevel(Math.min(score, 100)),
        score: Math.min(score, 100),
        factors,
        affectedSections: uniqueSections(affectedSections),
        confidence: getIndicatorConfidence(routeWeather, terrainData, routeIssues)
    };
}


function updateRouteOptionHazards(option) {
    option.floodIndicator = calculateFloodIndicator(option.weatherData, option.terrainData, option.nearbyIssues);
    option.landslideIndicator = calculateLandslideIndicator(option.weatherData, option.terrainData, option.nearbyIssues);
}


function formatRouteDuration(seconds) {
    const minutes = Math.max(0, Math.round(Number(seconds || 0) / 60));
    return minutes >= 60
        ? `${Math.floor(minutes / 60)}h ${minutes % 60}m`
        : `${minutes}m`;
}


function createRouteOption(route, index) {
    return {
        index,
        route,
        geometry: route.geometry,
        coordinates: getRouteCoordinates(route),
        distance: Number(route.distance) || 0,
        duration: Number(route.duration) || 0,
        distanceKm: (Number(route.distance) || 0) / 1000,
        durationMinutes: (Number(route.duration) || 0) / 60,
        terrain: null,
        terrainData: null,
        weather: null,
        weatherData: null,
        nearbyIssues: [],
        issueCounts: {},
        risk: null,
        riskScore: null,
        riskLevel: null,
        riskReasons: [],
        floodIndicator: null,
        landslideIndicator: null,
        error: null,
        layer: null
    };
}


function serializeRouteOption(option) {
    return {
        index: option.index,
        geometry: option.geometry,
        coordinates: option.coordinates,
        distance: option.distance,
        duration: option.duration,
        distanceKm: option.distanceKm,
        durationMinutes: option.durationMinutes,
        terrain: option.terrain,
        terrainData: option.terrainData,
        weather: option.weather,
        weatherData: option.weatherData,
        nearbyIssues: option.nearbyIssues,
        issueCounts: option.issueCounts,
        risk: option.risk,
        riskScore: option.riskScore,
        riskLevel: option.riskLevel,
        riskReasons: option.riskReasons,
        floodIndicator: option.floodIndicator,
        landslideIndicator: option.landslideIndicator
    };
}


function saveRouteSnapshot() {
    if (!currentRouteStart || !currentRouteEnd || !currentRouteOptions.length) return;

    const savedAt = new Date().toISOString();
    writeLocalJson(OFFLINE_STORAGE_KEYS.routeSnapshot, {
        version: OFFLINE_SNAPSHOT_VERSION,
        savedAt,
        dataFreshnessTimestamp: savedAt,
        route: {
            start: currentRouteStart,
            destination: currentRouteEnd,
            activeRouteIndex: activeRouteOptionIndex,
            options: currentRouteOptions.map(serializeRouteOption)
        },
        issues: currentActiveIssues,
        ai: aiRouteIntelligence
    });
}


function isValidRouteSnapshot(snapshot) {
    return snapshot?.version === OFFLINE_SNAPSHOT_VERSION &&
        snapshot.route?.start && snapshot.route?.destination &&
        Array.isArray(snapshot.route.options) && snapshot.route.options.length > 0 &&
        snapshot.route.options.every(option =>
            Array.isArray(option.coordinates) && option.coordinates.length >= 2 &&
            option.coordinates.every(point => Array.isArray(point) && point.length >= 2 && Number.isFinite(Number(point[0])) && Number.isFinite(Number(point[1])))
        );
}


function restoreRouteSnapshot(snapshot) {
    if (!isValidRouteSnapshot(snapshot) || !map) return false;

    currentRouteStart = snapshot.route.start;
    currentRouteEnd = snapshot.route.destination;
    activeRouteOptionIndex = Math.min(Number(snapshot.route.activeRouteIndex) || 0, snapshot.route.options.length - 1);
    currentActiveIssues = Array.isArray(snapshot.issues) ? snapshot.issues : [];
    aiRouteIntelligence = null;
    roadIssuesDataAvailable = true;
    currentRouteOptions = snapshot.route.options.map(option => ({
        ...option,
        index: Number(option.index) || 0,
        distance: Number(option.distance) || 0,
        duration: Number(option.duration) || 0,
        distanceKm: Number(option.distanceKm) || Number(option.distance || 0) / 1000,
        durationMinutes: Number(option.durationMinutes) || Number(option.duration || 0) / 60,
        nearbyIssues: Array.isArray(option.nearbyIssues) ? option.nearbyIssues : [],
        issueCounts: option.issueCounts || {},
        layer: null
    }));
    routeAnalyzing = false;
    startMarker = L.marker([currentRouteStart.lat, currentRouteStart.lon])
        .addTo(map)
        .bindPopup(`<b>Start</b><br>${currentRouteStart.displayName || "Cached start"}`);
    endMarker = L.marker([currentRouteEnd.lat, currentRouteEnd.lon])
        .addTo(map)
        .bindPopup(`<b>Destination</b><br>${currentRouteEnd.displayName || "Cached destination"}`);
    renderRouteLayers();
    applyRouteOption(currentRouteOptions[activeRouteOptionIndex], true);
    currentRouteOptions[activeRouteOptionIndex].route = { geometry: currentRouteOptions[activeRouteOptionIndex].geometry };
    routeLine = currentRouteOptions[activeRouteOptionIndex].layer;
    routeDistanceRemaining = currentRouteOptions[activeRouteOptionIndex].distance;
    routeWeatherData = currentRouteOptions[activeRouteOptionIndex].weatherData;
    routeTerrainData = currentRouteOptions[activeRouteOptionIndex].terrainData;
    currentRouteRisk = currentRouteOptions[activeRouteOptionIndex].risk;
    renderCachedIssueMarkers(currentActiveIssues);
    map.fitBounds(routeLine.getBounds(), { padding: [40, 40] });
    updateNetworkStatus(`Cached route — ${getCacheAgeText(snapshot.savedAt)}`);
    return true;
}


function tryRestoreOfflineRoute() {
    if (!isOffline) return false;
    return restoreRouteSnapshot(readLocalJson(OFFLINE_STORAGE_KEYS.routeSnapshot, null));
}


async function analyzeRouteOptions(routes, requestId) {
    if (currentRouteOptions.length !== routes.length) {
        currentRouteOptions = routes.map(createRouteOption);
    }
    updateSmartRouteDashboard();

    for (const option of currentRouteOptions) {
        if (requestId !== routeOptionsRequestId) return;

        try {
            option.terrainData = await fetchTerrainForCoordinates(option.coordinates);
            option.terrain = option.terrainData?.difficulty || "Unavailable";
        } catch (error) {
            console.warn(`Terrain unavailable for route ${option.index + 1}:`, error.message || error);
        }

        try {
            option.weatherData = await fetchRouteWeatherForCoordinates(option.coordinates, option.duration);
            option.weather = option.weatherData ? getWeatherStatus(option.weatherData) : "Unavailable";
        } catch (error) {
            console.warn(`Weather unavailable for route ${option.index + 1}:`, error.message || error);
        }

        option.nearbyIssues = getNearbyIssuesForRoute(option.coordinates, currentActiveIssues);
        option.issueCounts = getIssueTypeCounts(option.nearbyIssues);
        option.risk = calculateRouteRisk(null, null, option.nearbyIssues, option.weatherData, option.terrainData);
        option.riskScore = option.risk.score;
        option.riskLevel = option.risk.level;
        option.riskReasons = option.risk.reasons;
        updateRouteOptionHazards(option);
        updateSmartRouteDashboard();
    }

    renderRouteLayers();
    applyRouteOption(currentRouteOptions[activeRouteOptionIndex], false);
}


function applyRouteOption(option, resetProgress = true) {
    if (!option) return;

    activeRouteOptionIndex = option.index;
    routeLine = option.layer;
    currentRouteGeometry = option.geometry;
    currentRouteCoordinates = option.coordinates;
    currentRouteDurationSeconds = option.duration;
    routeDistanceRemaining = option.distance || null;
    routeTerrainData = option.terrainData;
    routeWeatherData = option.weatherData;
    currentRouteRisk = option.risk;

    if (resetProgress) {
        resetNavigationState();
        routeDistanceRemaining = option.distance || null;
    }

    updateRouteLayerStyles();
    removeRouteWeatherMarkers();
    removeRouteTerrainMarkers();
    if (routeWeatherData) showRouteWeatherMarkers(routeWeatherData);
    if (routeTerrainData) showRouteTerrainMarkers(routeTerrainData);
    showActiveHazardMarkers(option);
    if (currentUserLocation) updateNavigationForLocation();

    const resultElement = document.getElementById("routeResult");
    if (resultElement) {
        resultElement.innerHTML = `<strong>Route Found</strong><br>Distance: ${option.distanceKm.toFixed(1)} km<br>Estimated Time: ${formatRouteDuration(option.duration)}`;
    }

    setNavigationText("navigationRemaining", formatDistance(routeDistanceRemaining) + " remaining");
    setNavigationText("navigationRouteStatus", "Route status: Ready");
    updateSmartRouteDashboard();
}


function selectRouteOption(index) {
    const option = currentRouteOptions[Number(index)];
    if (!option || !option.layer) return;

    aiRouteIntelligence = null;
    aiRouteIntelligenceRequestId++;
    aiRouteIntelligenceLoading = false;
    applyRouteOption(option, true);
    if (!isOffline) saveRouteSnapshot();
    map.fitBounds(option.layer.getBounds(), { padding: [40, 40] });
}


function refreshRouteOptionIssueData() {
    invalidateAiRouteIntelligence();
    currentRouteOptions.forEach(option => {
        option.nearbyIssues = getNearbyIssuesForRoute(option.coordinates, currentActiveIssues);
        option.issueCounts = getIssueTypeCounts(option.nearbyIssues);
        option.risk = calculateRouteRisk(null, null, option.nearbyIssues, option.weatherData, option.terrainData);
        option.riskScore = option.risk.score;
        option.riskLevel = option.risk.level;
        option.riskReasons = option.risk.reasons;
        updateRouteOptionHazards(option);
    });

    const activeOption = currentRouteOptions[activeRouteOptionIndex];
    if (activeOption) {
        currentRouteRisk = activeOption.risk;
        routeWeatherData = activeOption.weatherData;
        routeTerrainData = activeOption.terrainData;
        showActiveHazardMarkers(activeOption);
    }
    if (!isOffline) saveRouteSnapshot();
    updateSmartRouteDashboard();
}


async function analyzeRouteWeather() {

    console.log(
        "================================"
    );

    console.log(
        "Starting route weather analysis..."
    );

    console.log(
        "Start:",
        currentRouteStart
    );

    console.log(
        "Destination:",
        currentRouteEnd
    );


    if (
        !currentRouteStart ||
        !currentRouteEnd
    ) {

        console.error(
            "Route coordinates are missing."
        );

        return;
    }


    routeWeatherData = null;
    removeRouteWeatherMarkers();
    showWeatherCard(null, true);

    const routeWeather = await fetchRouteWeather();
    const nearbyIssues = getNearbyRouteIssues(currentActiveIssues);
    const routeRisk = calculateRouteRisk(null, null, nearbyIssues, routeWeather, routeTerrainData);

    showRouteRiskCard(routeRisk);


    console.log(
        "Route weather analysis completed."
    );

    console.log(
        "================================"
    );
}


// ============================================================
// GEOCODING
// ============================================================

async function geocodePlace(place) {

    const url = window.location.protocol === "file:"
        ? `https://nominatim.openstreetmap.org/search?format=json&limit=1&q=${encodeURIComponent(place)}`
        : `/api/geocode?q=${encodeURIComponent(place)}`;

    try {

        const response = await fetch(url);

        if (!response.ok) {
            throw new Error("Geocoding request failed");
        }

        const data = await response.json();

        if (!data || data.length === 0) {

            throw new Error(
                `Location not found: ${place}`
            );
        }

        return {
            lat: parseFloat(data[0].lat),
            lon: parseFloat(data[0].lon),
            displayName: data[0].display_name
        };

    } catch (error) {

        console.error("Geocoding error:", error);

        throw error;
    }
}


// ============================================================
// WAIT FOR NOMINATIM
// ============================================================

function sleep(ms) {

    return new Promise(resolve => {
        setTimeout(resolve, ms);
    });
}


// ============================================================
// ANALYZE ROUTE
// ============================================================

const analyzeBtn =
    document.getElementById("analyzeBtn");


if (analyzeBtn) {

    analyzeBtn.addEventListener(
        "click",
        analyzeRoute
    );
}


async function analyzeRoute() {

    if (isOffline) {
        updateNetworkStatus("Offline: restore a cached route or reconnect to analyze a new route");
        return;
    }

    const startInput =
        document.getElementById("start") ||
        document.getElementById("from");

    const endInput =
        document.getElementById("end") ||
        document.getElementById("to");

    if (!startInput || !endInput) {

        console.error(
            "Start or destination input not found."
        );

        return;
    }

    const startPlace =
        startInput.value.trim();

    const endPlace =
        endInput.value.trim();


    if (!startPlace || !endPlace) {

        alert(
            "Please enter both starting point and destination."
        );

        return;
    }


    try {

        console.log("Searching locations...");


        // =========================
        // GEOCODE START
        // =========================

        const start =
            await geocodePlace(startPlace);


        // Nominatim rate limit protection
        await sleep(1100);


        // =========================
        // GEOCODE DESTINATION
        // =========================

        const end =
            await geocodePlace(endPlace);


        // Save route coordinates
        currentRouteStart = start;
        currentRouteEnd = end;
        routeAnalyzing = true;
        const optionsRequestId = ++routeOptionsRequestId;

        resetNavigationState();
        currentRouteOptions = [];
        currentRouteGeometry = null;
        currentRouteCoordinates = [];
        activeRouteOptionIndex = 0;
        aiRouteIntelligence = null;
        aiRouteIntelligenceRequestId++;
        aiRouteIntelligenceLoading = false;
        routeWeatherData = null;
        routeTerrainData = null;
        routeTerrainLoading = false;
        currentRouteRisk = null;
        currentRouteDurationSeconds = 0;
        routeWeatherRequestId++;
        routeTerrainRequestId++;
        routeWeatherCache = new Map();
        removeRouteWeatherMarkers();
        removeRouteTerrainMarkers();
        removeHazardMarkers();
        removeRouteLayers();

        const oldWeatherCard = document.getElementById("weatherCard");
        if (oldWeatherCard) oldWeatherCard.remove();
        updateSmartRouteDashboard();

        // New route = allow issue alerts again
        alertedIssueIds.clear();


        // =========================
        // REMOVE OLD ROUTE
        // =========================

        routeLine = null;


        if (startMarker) {

            map.removeLayer(startMarker);

            startMarker = null;
        }


        if (endMarker) {

            map.removeLayer(endMarker);

            endMarker = null;
        }


        // =========================
        // ADD START MARKER
        // =========================

        startMarker =
            L.marker([
                start.lat,
                start.lon
            ])
            .addTo(map)
            .bindPopup(
                `<b>Start</b><br>${start.displayName}`
            );


        // =========================
        // ADD END MARKER
        // =========================

        endMarker =
            L.marker([
                end.lat,
                end.lon
            ])
            .addTo(map)
            .bindPopup(
                `<b>Destination</b><br>${end.displayName}`
            );


        // =========================
        // OSRM ROUTING
        // =========================

        const routeUrl =
            `https://router.project-osrm.org/route/v1/driving/` +
            `${start.lon},${start.lat};` +
            `${end.lon},${end.lat}` +
            `?alternatives=true&overview=full&geometries=geojson`;


        console.log("Getting route...");


        const routeResponse =
            await fetch(routeUrl);


        if (!routeResponse.ok) {

            throw new Error(
                "Routing service failed."
            );
        }


        const routeData =
            await routeResponse.json();


        if (
            !routeData.routes ||
            routeData.routes.length === 0
        ) {

            throw new Error(
                "No route found."
            );
        }


        // =========================
        // LOAD ROAD ISSUES
        // =========================

        currentRouteOptions = routeData.routes.map(createRouteOption);
        renderRouteLayers();
        routeLine = currentRouteOptions[0].layer;
        currentRouteGeometry = currentRouteOptions[0].geometry;
        currentRouteCoordinates = currentRouteOptions[0].coordinates;
        currentRouteDurationSeconds = currentRouteOptions[0].duration;
        routeDistanceRemaining = currentRouteOptions[0].distance || null;
        updateSmartRouteDashboard();

        await loadRoadIssues();

        // =========================
        // TERRAIN, WEATHER, ISSUES AND RISK FOR EACH ROUTE
        // =========================

        await analyzeRouteOptions(routeData.routes, optionsRequestId);
        routeAnalyzing = false;
        applyRouteOption(currentRouteOptions[0], false);
        saveRouteSnapshot();

        map.fitBounds(routeLine.getBounds(), { padding: [40, 40] });
        updateSmartRouteDashboard();


        alert(
            "Route analysis completed successfully!"
        );


    } catch (error) {

        routeAnalyzing = false;
        updateSmartRouteDashboard();

        console.error(
            "Route analysis error:",
            error
        );


        alert(
            error.message ||
            "Something went wrong while analyzing the route."
        );
    }
}


// ============================================================
// ROAD ISSUE DISTANCE CHECK
// ============================================================

function distanceBetweenPoints(
    lat1,
    lon1,
    lat2,
    lon2
) {

    const R = 6371000;

    const lat1Rad =
        lat1 * Math.PI / 180;

    const lat2Rad =
        lat2 * Math.PI / 180;

    const dLat =
        (lat2 - lat1) *
        Math.PI / 180;

    const dLon =
        (lon2 - lon1) *
        Math.PI / 180;


    const a =
        Math.sin(dLat / 2) ** 2 +
        Math.cos(lat1Rad) *
        Math.cos(lat2Rad) *
        Math.sin(dLon / 2) ** 2;


    const c =
        2 *
        Math.atan2(
            Math.sqrt(a),
            Math.sqrt(1 - a)
        );


    return R * c;
}


// ============================================================
// CHECK ISSUE AGAINST ROUTE
// ============================================================

function checkIssueAgainstRoute(issue) {

    if (!routeLine) {
        return;
    }


    const routeLatLngs =
        routeLine.getLatLngs();


    if (
        !routeLatLngs ||
        routeLatLngs.length < 2
    ) {
        return;
    }


    const issueLat =
        parseFloat(issue.latitude);

    const issueLon =
        parseFloat(issue.longitude);


    let nearestDistance =
        Infinity;

    let distanceAlongRoute = 0;


    for (
        let i = 0;
        i < routeLatLngs.length - 1;
        i++
    ) {

        const pointA =
            routeLatLngs[i];

        const pointB =
            routeLatLngs[i + 1];


        const segmentLength =
            distanceBetweenPoints(
                pointA.lat,
                pointA.lng,
                pointB.lat,
                pointB.lng
            );


        // Convert coordinates to approximate
        // local Cartesian coordinates

        const latScale =
            111320;

        const lonScale =
            111320 *
            Math.cos(
                pointA.lat *
                Math.PI /
                180
            );


        const ax = 0;
        const ay = 0;


        const bx =
            (pointB.lng - pointA.lng) *
            lonScale;


        const by =
            (pointB.lat - pointA.lat) *
            latScale;


        const px =
            (issueLon - pointA.lng) *
            lonScale;


        const py =
            (issueLat - pointA.lat) *
            latScale;


        const segmentSquared =
            bx * bx +
            by * by;


        let t = 0;


        if (segmentSquared !== 0) {

            t =
                (px * bx + py * by) /
                segmentSquared;
        }


        t =
            Math.max(
                0,
                Math.min(1, t)
            );


        const closestX =
            ax +
            t * bx;


        const closestY =
            ay +
            t * by;


        const dx =
            px - closestX;


        const dy =
            py - closestY;


        const distance =
            Math.sqrt(
                dx * dx +
                dy * dy
            );


        if (
            distance <
            nearestDistance
        ) {

            nearestDistance =
                distance;

            distanceAlongRoute +=
                segmentLength * t;
        }


        if (
            distance >
            nearestDistance
        ) {

            distanceAlongRoute +=
                segmentLength;
        }
    }


    // Alert if road issue is within 2 km
    const ALERT_DISTANCE = 2000;


    if (
        nearestDistance <=
        ALERT_DISTANCE
    ) {

        showRouteIssueAlert(
            issue,
            nearestDistance,
            distanceAlongRoute
        );
    }
}


// ============================================================
// SHOW ROUTE ISSUE ALERT
// ============================================================

function showRouteIssueAlert(
    issue,
    distance,
    distanceAlongRoute
) {

    if (
        alertedIssueIds.has(
            issue.id
        )
    ) {

        return;
    }


    alertedIssueIds.add(
        issue.id
    );


    const oldAlert =
        document.getElementById(
            "routeIssueAlert"
        );


    if (oldAlert) {
        oldAlert.remove();
    }


    const alertBox =
        document.createElement("div");


    alertBox.id =
        "routeIssueAlert";


    const distanceMeters =
        Math.round(distance);


    const distanceText =
        distanceMeters < 1000
            ? `${distanceMeters} m`
            : `${(
                distanceMeters / 1000
            ).toFixed(1)} km`;


    const routePosition =
        (
            distanceAlongRoute / 1000
        ).toFixed(1);


    alertBox.innerHTML = `

        <div class="route-alert-header">
            ⚠️
            <strong>Route Alert</strong>
        </div>

        <div class="route-alert-type">
            ${issue.issue_type}
        </div>

        <div class="route-alert-description">
            ${issue.description}
        </div>

        <div class="route-alert-distance">
            📍 About ${distanceText}
            from your route
        </div>

        <div class="route-alert-position">
            🛣️ Approximately
            ${routePosition} km
            into the route
        </div>

        <button id="closeRouteAlert">
            Close Alert
        </button>

    `;


    document.body.appendChild(
        alertBox
    );


    const closeButton =
        document.getElementById(
            "closeRouteAlert"
        );


    if (closeButton) {

        closeButton.onclick =
            () => {

                alertBox.remove();
            };
    }


    // Automatically remove after 12 seconds

    setTimeout(
        () => {

            if (
                document.body.contains(
                    alertBox
                )
            ) {

                alertBox.remove();
            }

        },
        12000
    );
}


// ============================================================
// LOAD ROAD ISSUES
// ============================================================

async function loadRoadIssues() {

    if (isOffline) {
        updateNetworkStatus("Offline: using cached road reports");
        return;
    }

    if (!supabaseClient) {
        console.warn("Supabase client is unavailable; skipping issue load.");
        return;
    }

    try {

        const {
            data,
            error
        } =
            await supabaseClient
                .from("road_issues")
                .select("*")
                .eq("status", "active");


        if (error) {

            console.error(
                "Error loading road issues:",
                error
            );

            return;
        }


        // Remove old markers

        issueMarkers.forEach(
            marker => {

                map.removeLayer(
                    marker
                );
            }
        );


        issueMarkers = [];
        currentActiveIssues = data || [];
        roadIssuesDataAvailable = true;
        updateSmartRouteDashboard();


        // Add current issues

        if (data) {

            data.forEach(
                issue => {

                    addIssueMarker(
                        issue
                    );
                }
            );
        }

        updateSmartRouteDashboard();


    } catch (error) {

        console.error(
            "Road issue loading error:",
            error
        );
    }
}


// ============================================================
// ADD ISSUE MARKER
// ============================================================

function addIssueMarker(issue) {

    const lat =
        parseFloat(
            issue.latitude
        );

    const lon =
        parseFloat(
            issue.longitude
        );


    let icon = "⚠️";


    switch (
        issue.issue_type
    ) {

        case "Road Block":
            icon = "🚧";
            break;

        case "Accident":
            icon = "🚨";
            break;

        case "Flood":
            icon = "🌊";
            break;

        case "Landslide":
            icon = "⛰️";
            break;

        case "Traffic":
            icon = "🚗";
            break;

        case "Road Damage":
            icon = "🕳️";
            break;
    }


    const issueIcon =
        L.divIcon({

            html: `
                <div style="
                    font-size: 25px;
                    text-align: center;
                ">
                    ${icon}
                </div>
            `,

            className: "",

            iconSize: [
                30,
                30
            ],

            iconAnchor: [
                15,
                15
            ]
        });


    const marker =
        L.marker(
            [lat, lon],
            {
                icon:
                    issueIcon
            }
        )
        .addTo(map);


    marker.bindPopup(`

        <strong>
            ${icon}
            ${issue.issue_type}
        </strong>

        <br><br>

        ${issue.description}

        <br><br>

        <small>
            Reported:
            ${new Date(
                issue.created_at
            ).toLocaleString()}
        </small>

    `);


    issueMarkers.push(
        marker
    );

    updateSmartRouteDashboard();


    // Check whether this issue
    // is close to current route

    checkIssueAgainstRoute(
        issue
    );
}


// ============================================================
// REPORT ROAD ISSUE
// ============================================================

let selectedIssueType = null;

let selectedIssueDescription = null;


// =========================
// REPORT ISSUE BUTTON
// =========================

const reportButton =
    document.getElementById(
        "reportIssueBtn"
    ) || document.getElementById("reportIssue");


if (reportButton) {

    reportButton.addEventListener(
        "click",
        () => {

            const issueTypeElement =
                document.getElementById(
                    "issueType"
                );


            const descriptionElement =
                document.getElementById(
                    "issueDescription"
                );


            if (!issueTypeElement ||
                !descriptionElement) {

                alert(
                    "Issue form not found."
                );

                return;
            }


            selectedIssueType =
                issueTypeElement.value;


            selectedIssueDescription =
                descriptionElement.value.trim();


            if (!selectedIssueType) {

                alert(
                    "Please select an issue type."
                );

                return;
            }


            if (
                !selectedIssueDescription
            ) {

                alert(
                    "Please enter a description."
                );

                return;
            }


            alert(
                "Now click the location of the issue on the map."
            );


            map.once(
                "click",
                async event => {

                    await saveRoadIssue(
                        event.latlng.lat,
                        event.latlng.lng
                    );
                }
            );
        }
    );
}


// ============================================================
// SAVE ROAD ISSUE TO SUPABASE
// ============================================================

async function saveRoadIssue(
    latitude,
    longitude
) {

    if (isOffline) {
        const pendingIssue = {
            localId: createLocalIssueId(),
            issue_type: selectedIssueType,
            description: selectedIssueDescription,
            latitude: Number(latitude),
            longitude: Number(longitude),
            created_at: new Date().toISOString(),
            status: "pending_sync"
        };
        const pendingIssues = readPendingIssues();
        pendingIssues.push(pendingIssue);
        writePendingIssues(pendingIssues);
        addPendingIssueMarker(pendingIssue);
        updateNetworkStatus(`${pendingIssues.length} offline report${pendingIssues.length === 1 ? "" : "s"} pending sync`);
        const descriptionElement = document.getElementById("issueDescription");
        if (descriptionElement) descriptionElement.value = "";
        return;
    }

    if (!supabaseClient) {
        alert("Supabase is unavailable. The issue cannot be saved right now.");
        return;
    }

    try {

        const {
            data,
            error
        } =
            await supabaseClient
                .from("road_issues")
                .insert([
                    {
                        issue_type:
                            selectedIssueType,

                        description:
                            selectedIssueDescription,

                        latitude:
                            latitude,

                        longitude:
                            longitude,

                        status:
                            "active"
                    }
                ])
                .select()
                .single();


        if (error) {

            console.error(
                "Supabase insert error:",
                error
            );


            alert(
                "Failed to report road issue."
            );

            return;
        }


        alert(
            "Road issue reported successfully!"
        );


        // Add marker immediately

        if (data) {

            if (!currentActiveIssues.some(issue => issue.id === data.id)) {
                currentActiveIssues.push(data);
            }

            addIssueMarker(
                data
            );

            refreshRouteOptionIssueData();
        }


        // Clear form

        const descriptionElement =
            document.getElementById(
                "issueDescription"
            );


        if (descriptionElement) {

            descriptionElement.value =
                "";
        }


    } catch (error) {

        console.error(
            "Save issue error:",
            error
        );


        alert(
            "Something went wrong while reporting the issue."
        );
    }
}


async function syncPendingIssues() {
    if (isOffline || isSyncingPendingIssues || !supabaseClient) return;

    const pendingIssues = readPendingIssues();
    if (!pendingIssues.length) {
        updateNetworkStatus();
        return;
    }

    isSyncingPendingIssues = true;
    updateNetworkStatus("Syncing offline reports...");
    let syncedCount = 0;
    const remainingIssues = [];

    for (const issue of pendingIssues) {
        if (isOffline) {
            remainingIssues.push(issue);
            continue;
        }

        try {
            const { data, error } = await supabaseClient
                .from("road_issues")
                .insert([{
                    issue_type: issue.issue_type,
                    description: issue.description,
                    latitude: issue.latitude,
                    longitude: issue.longitude,
                    status: "active"
                }])
                .select()
                .single();

            if (error) throw error;
            removePendingIssueMarker(issue.localId);
            if (data) {
                if (!currentActiveIssues.some(existingIssue => existingIssue.id === data.id)) {
                    currentActiveIssues.push(data);
                    addIssueMarker(data);
                }
            }
            syncedCount++;
        } catch (error) {
            console.error("Offline issue sync failed:", error?.message || error);
            remainingIssues.push(issue);
        }
    }

    writePendingIssues(remainingIssues);
    isSyncingPendingIssues = false;
    refreshRouteOptionIssueData();
    if (syncedCount) await loadRoadIssues();
    updateNetworkStatus(syncedCount ? `${syncedCount} offline report${syncedCount === 1 ? "" : "s"} synced` : "Offline reports pending retry");
}


function handleOnline() {
    setOfflineState(false, "Reconnected");
    initializeRealtimeSubscription();
    clearTimeout(reconnectSyncTimer);
    reconnectSyncTimer = setTimeout(async () => {
        await syncPendingIssues();
        if (!isOffline) await loadRoadIssues();
    }, 500);
}


function handleOffline() {
    setOfflineState(true, "Connection lost; cached data remains available");
}


window.addEventListener("online", handleOnline);
window.addEventListener("offline", handleOffline);


// ============================================================
// SUPABASE REALTIME
// ============================================================

function initializeRealtimeSubscription() {
    if (!supabaseClient || realtimeChannelInitialized || isOffline) return;
    realtimeChannelInitialized = true;

    supabaseClient
        .channel(
            "road-issues-realtime"
        )
        .on(
            "postgres_changes",
            {
                event: "INSERT",
                schema: "public",
                table: "road_issues"
            },
            payload => {

            console.log(
                "New road issue received:",
                payload.new
            );


            const newIssue =
                payload.new;

            roadIssuesDataAvailable = true;

            if (!currentActiveIssues.some(issue => issue.id === newIssue.id)) {
                currentActiveIssues.push(newIssue);
            }


            // Prevent duplicate marker
            // if this browser already added it

            const alreadyExists =
                issueMarkers.some(
                    marker => {

                        const position =
                            marker.getLatLng();

                        const distance =
                            distanceBetweenPoints(
                                position.lat,
                                position.lng,
                                parseFloat(
                                    newIssue.latitude
                                ),
                                parseFloat(
                                    newIssue.longitude
                                )
                            );

                        return (
                            distance < 5
                        );
                    }
                );


            if (!alreadyExists) {

                addIssueMarker(
                    newIssue
                );
            }

            refreshRouteOptionIssueData();
            updateSmartRouteDashboard();
        }
        )
        .subscribe(
            status => {

                console.log(
                    "Realtime status:",
                    status
                );
            }
        );
}


// ============================================================
// INITIAL LOAD
// ============================================================

updateNetworkStatus();
if (!tryRestoreOfflineRoute()) {
    updateSmartRouteDashboard();
    if (!isOffline) {
        initializeRealtimeSubscription();
        loadRoadIssues();
    }
}


console.log(
    "NER Smart Logistics application loaded successfully."
);