// Google Maps JavaScript API dynamic library import bootstrap
// (https://developers.google.com/maps/documentation/javascript/load-maps-js-api),
// rewritten readably. The browser key is fetched from the server at runtime,
// so it never lives in source control or a build artefact.

let loading = null;

export function loadGoogleMaps({ key, v = 'weekly', region = 'AU', language = 'en-AU' }) {
  if (loading) return loading;
  loading = new Promise((resolve, reject) => {
    window.__gbmMapsAuthFailed = false;
    // Called by the Maps JavaScript API when the key is rejected (not enabled, wrong referrer, billing…).
    window.gm_authFailure = () => {
      window.__gbmMapsAuthFailed = true;
      window.dispatchEvent(new CustomEvent('gbm:maps-auth-failure'));
    };
    const google = (window.google ??= {});
    const maps = (google.maps ??= {});
    const requested = new Set();
    let scriptPromise;
    const params = new URLSearchParams({ key, v, region, language, callback: 'google.maps.__ib__' });
    const loadScript = () =>
      (scriptPromise ??= new Promise((ok, fail) => {
        const script = document.createElement('script');
        params.set('libraries', [...requested].join(','));
        script.src = `https://maps.googleapis.com/maps/api/js?${params}`;
        script.async = true;
        maps.__ib__ = ok;
        script.onerror = () => {
          scriptPromise = null;
          fail(new Error('The Google Maps JavaScript API could not be loaded (network or content blocker).'));
        };
        document.head.append(script);
      }));
    maps.importLibrary = (lib, ...rest) => {
      requested.add(lib);
      return loadScript().then(() => maps.importLibrary(lib, ...rest));
    };
    Promise.all([maps.importLibrary('maps'), maps.importLibrary('marker'), maps.importLibrary('core')])
      .then(([mapsLib, markerLib, coreLib]) => resolve({ ...coreLib, ...mapsLib, ...markerLib }))
      .catch(reject);
  });
  return loading;
}
