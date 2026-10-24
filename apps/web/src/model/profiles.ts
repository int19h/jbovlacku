/**
 * The calculation profiles that signed views can name, with the route rule
 * each one applies. The names come from the format specification. A result
 * reports the profile it used in `calculation.algorithm`; the page shows that
 * name and never substitutes another calculation for an unknown one.
 */
export const BOUNDS_PROFILE = "simple-routes-bounds-v1";
export const SHUN_PROFILE = "simple-routes-shun-v1";
export interface ProfileDescription {
  name: string;
  known: boolean;
  /** How public shuns act on routes under this profile. */
  shunRule: string;
  /** What an unfinished upper endpoint can contain under this profile. */
  upperCaveat: string;
}
export function describeProfile(name: string): ProfileDescription {
  if (name === BOUNDS_PROFILE)
    return {
      name,
      known: true,
      shunRule:
        "A public shun removes only the issuer's own trust edge. Routes through other people stay.",
      upperCaveat:
        "An unfinished upper endpoint is a bound. It is not received support.",
    };
  if (name === SHUN_PROFILE)
    return {
      name,
      known: true,
      shunRule:
        "A public shun removes the issuer's own trust edge, and a route is refused where any earlier actor on that route effectively shuns the next person. Independent routes and that person's own starting allocation stay. A refused share is not passed on.",
      upperCaveat:
        "An unfinished upper endpoint can include routes that effective shuns forbid. It is a bound, not received support.",
    };
  return {
    name,
    known: false,
    shunRule: "This client does not know the route rule of this profile.",
    upperCaveat: "",
  };
}
