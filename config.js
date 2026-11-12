/** Clave de cliente de TomTom, plan gratuito.
 *  Restringida al dominio alodyn.github.io. APIs habilitadas: Routing, Search y Geocoding.
 *  Trips geocodifica con Search y pide el coche a Routing con traffic=true.
 *  Fuera de ese dominio la petición se rechaza: la interfaz lo dice, no cambia de proveedor.
 */
export const CONFIG = {
  tomtomKey: "hTxfO56fRzTG01Od9KxTuZsPc9RsZLhq",
  tomtomSearch: "https://api.tomtom.com/search/2/search/",
  tomtomRoute: "https://api.tomtom.com/routing/1/calculateRoute/",
  fuelApi: "https://sedeaplicaciones.minetur.gob.es/ServiciosRESTCarburantes/PreciosCarburantes",
  otpBase: null, // p. ej. "https://otp.ejemplo.es". Para pruebas: ?otp=http://127.0.0.1:8080
  madridProvinceId: "28",
  madridBias: { lat: 40.4168, lon: -3.7038, radius: 120000 }
};
