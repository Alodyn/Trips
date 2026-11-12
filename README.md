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
js/fuel.js       media del Ministerio y coste km × consumo / 100 × precio
js/fares.js      abono frente a sencillos
js/parkride.js   tres disuasorios a lo largo del corredor
js/transit.js    hueco para OpenTripPlanner 2 (hoy, pendiente de horarios)
js/geo.js        punto en corona y estaciones por nombre
data/            zonas, estaciones, aparcamientos y tarifas
fixtures/        muestra local de TomTom
```

Flujo de una comparación:

1. Search de TomTom, sesgado a España y a Madrid (`countrySet=ES`, radio 120 km alrededor de Sol). Si la clave rechaza la petición, se muestra el error. No hay otro geocodificador detrás.
2. La corona del punto sale del polígono CRTM. Si el nombre es exactamente el de una estación del catálogo, manda el campo `CORONATARIFARIA`.
3. Routing con `traffic=true`, `computeTravelTimeFor=all` y la próxima hora de salida en Europe/Madrid.
4. Para la combinada, tres aparcamientos disuasorios que quedan a medio camino (no el más cercano a casa ni el del destino). A cada uno se le pide el tramo en coche. El tramo de transporte no tiene minutos.
5. El abono se calcula con las coronas del tramo que de verdad va en transporte: en la combinada, del aparcamiento al destino.

Las búsquedas van con 450 ms de espera. Rutas y búsquedas acertadas se guardan solo en `sessionStorage`, para no repetir la misma llamada en la sesión. Un 403 se recuerda en memoria y no se reintenta solo.

## TomTom

La clave de cliente está en `config.js`. Es de plan gratuito y está **restringida a `alodyn.github.io`**. Tiene habilitadas Routing, Search y Geocoding. Trips geocodifica con **Search** (`/search/2/search/`) y pide el coche a **Routing**.

No se usa Nominatim. Search está habilitado; un geocodificador de reserva ocultaría un rechazo de la clave.

En el mapa se dibuja la polilínea del coche sobre teselas de OpenStreetMap, con la atribución de OSM y la de TomTom en la línea de fuentes. Conviene leer los términos de TomTom por si el producto exige además sus propias teselas.

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

La pestaña Aparcamientos es un mapa Leaflet (teselas OSM, con atribución) y la lista.

## Transporte público

`js/transit.js` exporta `planTransit`. Hoy devuelve `status: "pending"` y ningún minuto. La interfaz solo pinta una duración si `status === "ok"`. El comentario del módulo deja la consulta GraphQL `plan` de OTP 2 para sustituir el cuerpo sin cambiar el resultado.

Hasta que exista un GTFS de Metro vigente no tiene sentido servir horarios de suburbano. El estudio del 12/11/2026 lo explica: el feed público caduca el 27/05/2026.

## PWA

`manifest.webmanifest`, iconos, `apple-touch-icon` y un service worker que precachea la interfaz. El Ministerio va en red con copia por si no hay conexión. TomTom y las teselas no se cachean. En un móvil de 390 px la barra de pestañas flota abajo; desde 900 px el inicio, la comparación y los aparcamientos pasan a dos columnas.

## Despliegue

`.github/workflows/pages.yml` publica la rama `main` en GitHub Pages (sitio estático, sin build). Hace falta activar Pages con el origen «GitHub Actions» en el repositorio.

## Licencias y fuentes

- CRTM, coronas, estaciones y aparcamientos: [licencia de uso del CRTM](https://www.crtm.es/licencia-de-uso). Capas ArcGIS `CoronasTarifarias_Vigentes_CRTM`, estaciones M4–M10 y `AparcamientosCM` (16/12/2025).
- Ayuntamiento de Madrid, tres disuasorios que faltan en el CRTM: [dataset](https://datos.madrid.es/dataset/300531-0-aparcamientos-publicos), CC BY 4.0. Coordenadas del CSV a 12/11/2026.
- Ministerio para la Transición Ecológica, precios de carburantes: API REST `ServiciosRESTCarburantes`, actualización cada media hora.
- OpenStreetMap: teselas © colaboradores de OpenStreetMap.
- TomTom: ruta y búsqueda con la clave de cliente. © TomTom.
- Tarifas: [BOCM 31/12/2025](https://www.crtm.es/media/sjqj4ggj/bocm-20251231-tarifas_transporte.pdf), [nota del CRTM 29/12/2025](https://www.crtm.es/comunicacion/sala-de-prensa/noticias/noticias/29122025-la-comunidad-de-madrid-mantiene-los-precios-del-transporte-publico/), [tarifa única de Metro Zona A, 10/09/2026](https://www.comunidad.madrid/noticias/2026/09/10/diaz-ayuso-anuncia-tarifa-unica-15-euros-billete-sencillo-zona-metro-octubre), [Cercanías Renfe](https://www.renfe.com/es/es/cercanias/cercanias-madrid/tarifas/billetes) (consulta 12/11/2026).
- Vehículos: `vehicles.json` de Surtidor (fichas km77 y folletos de fabricante).

## Siguientes pasos

1. Comprobar en [alodyn.github.io/Trips](https://alodyn.github.io/Trips/) un trayecto real: tiempo con tráfico, coste de combustible y abono. La clave solo responde ahí.
2. Cuando el CRTM publique un GTFS de Metro vigente, levantar OTP 2 (el grafo no cabe en GitHub Pages) y rellenar `planTransit` con la consulta GraphQL que ya está documentada en `js/transit.js`. El tramo en coche se queda en TomTom: OTP no usa tráfico.
3. Con el itinerario real, sustituir el sencillo estimado por el título del modo que salga (y `cercaniasSingle` si el tramo es de Cercanías) y sumar el tiempo de transporte al del coche.
4. El 1/01/2027, revisar si la rebaja del abono se prorroga. Si no, el JSON ya cae a la tarifa oficial.
