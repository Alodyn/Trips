# Trips

App web para comparar, en la Comunidad de Madrid, tres maneras de hacer el mismo trayecto: **coche con tráfico**, **transporte público** y **combinada** (coche hasta un aparcamiento disuasorio y luego transporte público). De cada una enseña el tiempo cuando es real, el coste del viaje y el coste al mes si se repite.

Es una PWA estática, en español, sin backend y sin cuenta. El coche, el perfil y los favoritos se quedan en el móvil (`localStorage`). La publicación prevista es [https://alodyn.github.io/Trips/](https://alodyn.github.io/Trips/).

El sistema visual sale de Surtidor: tema Claro por defecto (vidrio, grano y malla pastel) y, si se quieren, Grafito, Grafito oscuro y Medianoche.

## Probarlo en local

```bash
python3 -m http.server 8765
```

Abrir `http://127.0.0.1:8765/`. En localhost la app **no llama a TomTom**: la clave está limitada al dominio `alodyn.github.io` y desde cualquier otro sitio responde 403 (`InvalidReferer` en Routing). En su lugar entra el modo de muestra, con un aviso visible en la pantalla:

- la ruta Griñón → Hospital Universitario 12 de Octubre es una **respuesta real** de TomTom Routing grabada el 12/11/2026 (`traffic=true`, salida a las 7:00, 28,9 km, 27 min);
- la búsqueda de esa muestra **no se pudo grabar** (Search ya devolvía 403) y reutiliza las coordenadas de aquella petición, con la forma del API de Search;
- el resto de tramos en coche no se inventan: la interfaz dice que no están en la muestra.

`?fixtures=0` fuerza la red también en local, para ver el error de rechazo. `?fixtures=1` activa la muestra en cualquier host.

**La comprobación de punta a punta con TomTom en vivo tiene que hacerse en el sitio publicado**, [https://alodyn.github.io/Trips/](https://alodyn.github.io/Trips/). Desde esta máquina no se puede: la clave rechaza el referer.

El precio del carburante sí sale en vivo del Ministerio, también en local.

## Arquitectura

No hay build. GitHub Pages sirve la raíz del repositorio.

```
index.html, styles.css, manifest, sw.js, config.js, vehicles.json
js/app.js        interfaz y estado
js/tomtom.js     Search (geocodificación) y Routing (coche, traffic=true)
js/traffic.js    margen de hora punta sobre el tiempo de TomTom
js/fuel.js       media del Ministerio y coste km × consumo / 100 × precio
js/fares.js      abono frente a sencillos
js/parkride.js   disuasorios y estaciones con aparcamiento
js/destpark.js   dónde dejar el coche en el destino
js/transit.js    OpenTripPlanner 2, opcional
js/geo.js        punto en corona y estaciones por nombre
data/            zonas, estaciones, aparcamientos, destino y tarifas
fixtures/        muestra local de TomTom
```

Flujo de una comparación (el mismo en todas las búsquedas):

1. Search de TomTom, sesgado a España y a Madrid (`countrySet=ES`, radio 120 km alrededor de Sol). Si la clave rechaza la petición, se muestra el error. No hay otro geocodificador detrás.
2. La corona del punto sale del polígono CRTM. Si el nombre es exactamente el de una estación del catálogo, manda el campo `CORONATARIFARIA`.
3. Hora de salida y, si hay vuelta, hora de regreso, en el tipo de día elegido (laborable, sábado o domingo). Routing con `traffic=true` y `computeTravelTimeFor=all`. En hora punta laborable el tiempo sube hasta el índice de tráfico de TomTom para Madrid; el margen se puede cambiar a mano en Coche y perfil.
4. Combinada: el aparcamiento habitual, la estación con parking más cercana al origen en el sentido del viaje, y el resto del corredor. El tramo en coche es de TomTom. El de transporte, de OTP si hay servidor.
5. Coche hasta el destino: zona blanca fuera del SER (a pie o en metro), aparcamiento público, plaza alquilada, SER si cabe en la jornada, o «tengo plaza». La búsqueda de sitio en zona blanca se edita.
6. El abono se calcula con las coronas del tramo que va en transporte. En la combinada, del aparcamiento al destino.

Las búsquedas van con 450 ms de espera. Rutas y búsquedas acertadas se guardan solo en `sessionStorage`, para no repetir la misma llamada en la sesión. Un 403 se recuerda en memoria y no se reintenta solo.

## TomTom

La clave de cliente está en `config.js`. Es de plan gratuito y está **restringida a `alodyn.github.io`**. Tiene habilitadas Routing, Search y Geocoding. Trips geocodifica con **Search** (`/search/2/search/`) y pide el coche a **Routing**.

No se usa Nominatim. Search está habilitado; un geocodificador de reserva ocultaría un rechazo de la clave.

En el mapa se dibuja la polilínea del coche sobre teselas de OpenStreetMap, con la atribución de OSM y la de TomTom en la línea de fuentes. Conviene leer los términos de TomTom por si el producto exige además sus propias teselas.

Para una salida futura TomTom devuelve su perfil histórico, no el atasco de dentro de un rato. En hora punta de un laborable (7:00–10:00 y 17:00–20:00) Trips se queda con el mayor de esos tiempos y, si hace falta, lo sube hasta la congestión media del [TomTom Traffic Index de Madrid 2025](https://www.tomtom.com/traffic-index/city/madrid/): 62 % por la mañana y 59 % por la tarde, medido sobre el tiempo sin tráfico. Cada trayecto guardado puede llevar un margen propio, en la pestaña Coche. Es una predicción, no una medición del día.

## Carburante

`GET …/EstacionesTerrestres/FiltroProvincia/28` (Madrid), el mismo servicio que Surtidor, con CORS abierto. Se promedia el carburante elegido en el municipio del origen si hay al menos dos estaciones; si no, la provincia.

```
coste € = kilómetros × consumo (l/100 km) / 100 × precio €/l
```

El consumo y el depósito salen de `vehicles.json` (el de Surtidor). Por defecto, Volvo S60 D3/D4/D5 de 2010–2018, 4,5 l/100 km y gasóleo A. El perfil, los días al mes y la ida y vuelta se pueden cambiar; el importe se recalcula sin volver a pedir la ruta.

## Tarifas CRTM 2026

`data/fares.json` guarda cada precio con fuente, fecha y vigencia. `recommendFare({ zones, age, trips, onDate })` en `js/fares.js`:

- 0–14 años y 65 o más: gratuidad hasta el 31/12/2026. No hay precio de reposición para 2027 en los datos, así que a partir de esa fecha no se inventa uno.
- 15–25 años: Abono Joven, 10 € en toda la región (oficial 20 €) hasta el 31/12/2026.
- 26–64: abono de 30 días de la corona que cubre el viaje (un B2 incluye A y B1). C1 y C2 no se incluyen entre sí; si un viaje toca las dos ramas, se avisa de que el interzonal no está tarifado aquí.
- Se compara el abono con los sencillos del mes y, si el viaje se queda en zona A, con el bono de 10 viajes (7,30 €). Gana el más barato.
- Sin itinerario, el sencillo fuera de la zona A es el interurbano entre municipios (3,00 €). No es un billete medido: es el título que sí está publicado. En zona A, Metro y EMT cuestan 1,50 €.
- El sencillo de Cercanías Renfe (zonas 1–7, no coronas) está en el JSON y en `cercaniasSingle`, listo para cuando OTP diga cuántas zonas Renfe cruza. Hoy no se cobra.

El 1/01/2027, si no hay prórroga, el cálculo del abono normal pasa a la tarifa oficial del BOCM.

## Zonas y aparcamientos

Generados con `tools/build_data.py` a partir de los extractos del CRTM del 12/11/2026 (no se versionan: el GeoJSON de coronas pesa demasiado).

| Fichero | Qué es |
|---|---|
| `data/zones.json` | 8 coronas, Douglas-Peucker ~55 m. 100 % de acuerdo con el polígono original en la comprobación |
| `data/stations.json` | Metro, Cercanías, Metro Ligero, EMT, interurbanos y urbanos, con `CORONATARIFARIA` (inventario 29/05/2026). Sin coordenadas |
| `data/parkings.json` | 71 de AparcamientosCM más Fuente de la Mora, Islazul y Pitis del Ayuntamiento, que no están en esa capa |
| `data/station_parkings.json` | Estación de Cercanías, Metro o Metro Ligero y el aparcamiento a menos de 350 m. Lo genera `tools/build_station_parkings.py` |
| `data/dest_parking.json` | Límite del SER, calles de zona blanca, parkings públicos y una referencia de plaza alquilada. Lo genera `tools/build_dest_parking.py` |

La pestaña Aparcamientos es un mapa Leaflet (teselas OSM, con atribución) y la lista de disuasorios.

La capa `AparcamientosCM` **repite el identificador** en sitios distintos: `28_079_7` es La Garena y también Pavones, y hay otros 16 códigos en el mismo caso. En la lista y en el mapa cada sitio usa `pr:{id}:{nombre}`, así que elegir uno no selecciona al otro. El código original de la capa se conserva en `layerId`.

## Aparcar en destino

En cada búsqueda el coche no da por hecho que la calle es gratis. `js/destpark.js` compara, para ese destino:

- zona blanca (calle fuera del SER, según el Geoportal de Madrid): el coche llega, se suman los minutos de búsqueda y el último tramo a pie o en metro;
- un aparcamiento público cercano, con la tarifa publicada o «sin dato»;
- una plaza de garaje alquilada, con un precio editable;
- el SER, solo si la estancia cabe en el horario y el tiempo máximo;
- «Tengo plaza», si el destino es tuyo.

El punto de zona blanca que sueles usar, y los minutos para encontrar sitio, se guardan con el destino. El aparcamiento disuasorio habitual (pestaña Coche) entra siempre en la combinada, esté donde esté, junto con la estación con parking más cercana al origen en el sentido del viaje.

## Transporte público

`js/transit.js` llama a OpenTripPlanner 2 (`POST {base}/otp/gtfs/v1`, consulta GraphQL `plan`) si hay un servidor. Se indica en `config.js` con `otpBase`, o en la URL con `?otp=https://…` (queda en `localStorage`, clave `trips.v1.otp`). `?otp=off` lo olvida.

Sin esa dirección, `planTransit` devuelve `status: "pending"` y la interfaz dice **«pendiente de horarios»**. No pinta minutos. Con servidor, solo enseña una duración si `status === "ok"`.

El tramo en coche del park and ride no se le pide a OTP: OTP no usa tráfico. OTP puede proponer candidatos (`parkRideHints`); el tiempo en coche lo vuelve a calcular TomTom.

### Límites de los horarios

- El GTFS de Metro que alimenta el grafo está caducado (el calendario público llega al 27/05/2026). Los horarios de suburbano son los de 2025, con el calendario refechado. Si el itinerario lleva Metro, la app lo dice.
- El GTFS de interurbanos del CRTM trae viajes imposibles. El caso conocido es el 223 Alcalá–Avenida de América en 12 minutos, cuando el real ronda los 40 o más. Cada itinerario se mira por velocidad media del tramo (autobús por encima de 65 km/h en más de 3 km, y umbrales parecidos en tranvía, metro y tren). Esos `trip` se excluyen y se vuelve a preguntar, hasta seis veces. Lo descartado se nombra en la ficha.

## PWA

`manifest.webmanifest`, iconos, `apple-touch-icon` y un service worker que precachea la interfaz. El Ministerio va en red con copia por si no hay conexión. TomTom y las teselas no se cachean. En un móvil de 390 px la barra de pestañas flota abajo; desde 900 px el inicio, la comparación y los aparcamientos pasan a dos columnas.

## Despliegue

`.github/workflows/pages.yml` publica la rama `main` en GitHub Pages (sitio estático, sin build). Hace falta activar Pages con el origen «GitHub Actions» en el repositorio.

## Licencias y fuentes

- CRTM, coronas, estaciones y aparcamientos: [licencia de uso del CRTM](https://www.crtm.es/licencia-de-uso). Capas ArcGIS `CoronasTarifarias_Vigentes_CRTM`, estaciones M4–M10 y `AparcamientosCM` (16/12/2025).
- Ayuntamiento de Madrid, tres disuasorios que faltan en el CRTM: [dataset](https://datos.madrid.es/dataset/300531-0-aparcamientos-publicos), CC BY 4.0. Coordenadas del CSV a 12/11/2026.
- SER y aparcamientos públicos municipales (aparcar en destino): Geoportal y [datos.madrid.es](https://datos.madrid.es/dataset/202625-0-aparcamientos-publicos), CC BY 4.0. Calles de zona blanca y parkings junto a estación: OpenStreetMap, ODbL.
- Ministerio para la Transición Ecológica, precios de carburantes: API REST `ServiciosRESTCarburantes`, actualización cada media hora.
- OpenStreetMap: teselas © colaboradores de OpenStreetMap.
- TomTom: ruta y búsqueda con la clave de cliente. © TomTom.
- Tarifas: [BOCM 31/12/2025](https://www.crtm.es/media/sjqj4ggj/bocm-20251231-tarifas_transporte.pdf), [nota del CRTM 29/12/2025](https://www.crtm.es/comunicacion/sala-de-prensa/noticias/noticias/29122025-la-comunidad-de-madrid-mantiene-los-precios-del-transporte-publico/), [tarifa única de Metro Zona A, 10/09/2026](https://www.comunidad.madrid/noticias/2026/09/10/diaz-ayuso-anuncia-tarifa-unica-15-euros-billete-sencillo-zona-metro-octubre), [Cercanías Renfe](https://www.renfe.com/es/es/cercanias/cercanias-madrid/tarifas/billetes) (consulta 12/11/2026).
- Vehículos: `vehicles.json` de Surtidor (fichas km77 y folletos de fabricante).

## Siguientes pasos

1. Comprobar en [alodyn.github.io/Trips](https://alodyn.github.io/Trips/) un trayecto real: tiempo con tráfico, coste de combustible y abono. La clave solo responde ahí.
2. Publicar el OTP de Madrid y poner su URL en `otpBase` o abrir la app con `?otp=`. Sin eso, el transporte sigue en «pendiente de horarios».
3. Cuando el CRTM publique un GTFS de Metro vigente, reconstruir el grafo y quitar el aviso de horarios de 2025. El tramo en coche se queda en TomTom.
4. Con el itinerario real, afinar el sencillo al modo que salga (y `cercaniasSingle` si el tramo es de Cercanías).
5. El 1/01/2027, revisar si la rebaja del abono se prorroga. Si no, el JSON ya cae a la tarifa oficial.
