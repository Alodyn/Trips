/**
 * Transporte público.
 *
 * El servidor OpenTripPlanner todavía no existe. `planTransit` devuelve un
 * resultado pendiente, sin minutos. Cuando haya un OTP 2, se sustituye el
 * cuerpo de esta función por la consulta de abajo. La forma del resultado
 * no cambia: la interfaz solo pinta un tiempo si `status === "ok"`.
 *
 * El tramo en coche del park and ride no se pide aquí. OTP no usa tráfico;
 * ese tramo lo calcula TomTom en js/tomtom.js.
 *
 * Consulta prevista (OTP 2, GraphQL `plan`):
 *
 *   POST {base}/otp/gtfs/v1
 *   content-type: application/json
 *
 *   {
 *     "query": "query Plan($from: InputCoordinates!, $to: InputCoordinates!, $date: String!, $time: String!) {
 *       plan(
 *         from: $from
 *         to: $to
 *         date: $date
 *         time: $time
 *         transportModes: [
 *           { mode: WALK },
 *           { mode: BUS },
 *           { mode: RAIL },
 *           { mode: SUBWAY },
 *           { mode: TRAM }
 *         ]
 *       ) {
 *         itineraries {
 *           duration
 *           startTime
 *           endTime
 *           numberOfTransfers
 *           legs {
 *             mode
 *             duration
 *             distance
 *             from { name lat lon }
 *             to { name lat lon }
 *             route { shortName }
 *           }
 *         }
 *       }
 *     }",
 *     "variables": {
 *       "from": { "lat": 40.29, "lon": -3.74 },
 *       "to": { "lat": 40.38, "lon": -3.70 },
 *       "date": "2026-11-16",
 *       "time": "08:00"
 *     }
 *   }
 *
 * El itinerario elegido debería rellenar:
 *   { status: "ok", itinerary: { durationMin, transfers, legs: [{ mode, from, to, route, durationMin }] } }
 *
 * Mientras Metro no tenga un GTFS vigente, un OTP de Madrid no puede dar
 * horarios de suburbano fiables. Ver el estudio del 12/11/2026.
 */

export async function planTransit(_request) {
  return {
    status: "pending",
    reason: "no-otp",
    itinerary: null,
    message: "Pendiente de horarios. El planificador (OpenTripPlanner) todavía no está conectado."
  };
}

export function transitIsReal(plan) {
  return Boolean(
    plan
    && plan.status === "ok"
    && plan.itinerary
    && Number.isFinite(plan.itinerary.durationMin)
  );
}
