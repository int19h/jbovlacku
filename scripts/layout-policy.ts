import ts from "typescript";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { sentenceLinks } from "../apps/web/src/lib/dom.ts";
import postcss from "postcss";

// These selectors are the complete authority for smaller interactive targets.
export const TARGET_SELECTOR =
  ':where(a,button,input:not([type="hidden"]),select,textarea,summary,[role="button"],[role="switch"],[role="link"],[tabindex]:not([tabindex^="-"]),[contenteditable]:not([contenteditable="false"]),label:has(input:is([type="checkbox"],[type="radio"])))';
export const BOX_SELECTOR =
  ':where(a,button,summary,[role="button"],[role="switch"],[role="link"])';
export const BLOCK_SELECTOR =
  ':where([tabindex]:not([tabindex^="-"]),[contenteditable]:not([contenteditable="false"])):not(:where(a,button,summary,[role="button"],[role="switch"],[role="link"]))';
export const PROSE_SELECTOR =
  ".inline-prose[data-inline-prose-reason] > a:not(.btn,.touch-link,.pl)";
export const PLACE_SELECTOR = "a.pl[data-inline-place-reason]";
export const PROXY_SELECTOR =
  'label:is(.check,.opt,.chip):has(> input:only-of-type) > input:is([type="checkbox"],[type="radio"]),.seg label:has(> input:only-of-type) > input:is([type="checkbox"],[type="radio"])';
const normalize = (value: string) => value.replace(/\s+/g, "");
const same = (a: string, b: string) => normalize(a) === normalize(b);
const SAFE_DISPLAY =
  /^(?:none|block|inline-block|flex|inline-flex|grid|inline-grid|flow-root|list-item|table)$/;
const DOM_PATH = fileURLToPath(
  new URL("../apps/web/src/lib/dom.ts", import.meta.url),
);
const MARKER_PATH = fileURLToPath(
  new URL("../apps/web/src/model/richtext.ts", import.meta.url),
);
const protectedProperties =
  /^(?:min-(?:width|height|inline-size|block-size)|display|all|flex-shrink|transform|scale|zoom|clip|clip-path)$/;

export function inspectLayoutCss(
  source: string,
  name = "styles.css",
): string[] {
  const errors: string[] = [];
  const root = postcss.parse(source, { from: name });
  const rules = new Map<string, postcss.Rule>();
  root.walkRules((rule) => {
    if (
      [
        TARGET_SELECTOR,
        BOX_SELECTOR,
        BLOCK_SELECTOR,
        PROSE_SELECTOR,
        PLACE_SELECTOR,
        PROXY_SELECTOR,
      ].some((selector) => same(rule.selector, selector)) &&
      rules.has(normalize(rule.selector))
    )
      errors.push(`${name}: duplicate target contract rule ${rule.selector}`);
    if (
      [
        TARGET_SELECTOR,
        BOX_SELECTOR,
        BLOCK_SELECTOR,
        PROSE_SELECTOR,
        PLACE_SELECTOR,
        PROXY_SELECTOR,
      ].some((selector) => same(rule.selector, selector)) &&
      rule.parent?.type !== "root"
    )
      errors.push(`${name}: target contracts must apply in every state`);
    rules.set(normalize(rule.selector), rule);
  });
  const target = rules.get(normalize(TARGET_SELECTOR));
  for (const [property, value] of Object.entries({
    "min-width": "max(44px,var(--target-min-width,0px))",
    "min-height": "max(44px,var(--target-min-height,0px))",
  })) {
    if (
      target?.nodes.filter(
        (node) => node.type === "decl" && node.prop.toLowerCase() === property,
      ).length !== 1 ||
      !target?.nodes.some(
        (node) =>
          node.type === "decl" &&
          node.prop.toLowerCase() === property &&
          normalize(node.value) === value &&
          node.important,
      )
    ) {
      errors.push(`${name}: the shared target rule must protect ${property}`);
    }
  }
  if (
    !rules
      .get(normalize(BOX_SELECTOR))
      ?.nodes.some(
        (node) =>
          node.type === "decl" &&
          node.prop === "display" &&
          node.value === "inline-flex",
      )
  )
    errors.push(`${name}: the default must size bare inline anchors`);
  root.walkDecls((decl) => {
    decl.prop = decl.prop.toLowerCase();
    const selector =
      decl.parent?.type === "rule"
        ? (decl.parent as postcss.Rule).selector
        : "";
    const exception = [PROSE_SELECTOR, PLACE_SELECTOR, PROXY_SELECTOR].some(
      (allowed) => same(selector, allowed),
    );
    const shared = same(selector, TARGET_SELECTOR);
    if (shared && !/^(?:min-width|min-height)$/.test(decl.prop))
      errors.push(
        `${name}: the shared minimum rule cannot add another sizing override`,
      );

    if (exception) {
      const expected: Record<string, string> = {
        "min-width": same(selector, PLACE_SELECTOR) ? "1.45em" : "0",
        "min-height": same(selector, PLACE_SELECTOR) ? "1.45em" : "0",
      };
      if (same(selector, PROSE_SELECTOR)) expected.display = "inline";
      if (
        !(decl.prop in expected) ||
        normalize(decl.value) !== expected[decl.prop] ||
        (decl.prop !== "display" && !decl.important)
      )
        errors.push(
          `${name}: unbounded exception declaration in ${selector}: ${decl.prop}`,
        );
    }

    if (
      protectedProperties.test(decl.prop) &&
      decl.important &&
      !shared &&
      !exception &&
      !(
        same(selector, "[hidden]") &&
        decl.prop === "display" &&
        decl.value === "none"
      )
    )
      errors.push(
        `${name}: unapproved target opt-out in ${selector}: ${decl.prop}`,
      );
    if (
      decl.prop === "display" &&
      !SAFE_DISPLAY.test(decl.value) &&
      !(exception && decl.value === "inline")
    )
      errors.push(
        `${name}: inline sizing needs a reasoned exception in ${selector}`,
      );
    if (
      /^(transform|scale|zoom)$/.test(decl.prop) &&
      !/^(none|rotate\([^)]*\)|translate[XY]?\([^)]*\))$/.test(decl.value)
    )
      errors.push(`${name}: target shrinking is not permitted in ${selector}`);
    if (
      /^(clip|clip-path)$/.test(decl.prop) &&
      !(
        same(selector, ".sr") &&
        decl.prop === "clip" &&
        decl.value === "rect(0 0 0 0)"
      )
    )
      errors.push(`${name}: clipping cannot reduce a target in ${selector}`);
    if (decl.prop === "all")
      errors.push(`${name}: all can erase the default target`);
    if (
      decl.prop.startsWith("--target-min-") &&
      !/^(?:[4-9]\d|\d{3,})(?:px)$|^(?:[3-9]|\d{2,})(?:\.\d+)?rem$/.test(
        decl.value,
      )
    )
      errors.push(`${name}: a custom target minimum must be at least 44px`);
  });
  for (const [selector, width, height] of [
    [PROSE_SELECTOR, "0", "0"],
    [PLACE_SELECTOR, "1.45em", "1.45em"],
    [PROXY_SELECTOR, "0", "0"],
  ]) {
    const rule = rules.get(normalize(selector));
    for (const [property, value] of [
      ["min-width", width],
      ["min-height", height],
    ]) {
      if (
        !rule?.nodes.some(
          (node) =>
            node.type === "decl" &&
            node.prop.toLowerCase() === property &&
            node.value === value &&
            node.important,
        )
      )
        errors.push(
          `${name}: missing bounded exception ${selector}: ${property}`,
        );
    }
  }
  return errors;
}

export function inspectLayoutSource(
  source: string,
  name = "page.ts",
): string[] {
  const file = ts.createSourceFile(
    name,
    source,
    ts.ScriptTarget.Latest,
    true,
    ts.ScriptKind.TS,
  );
  const errors: string[] = [];
  const inDom = resolve(name) === DOM_PATH;
  const inMarkers = resolve(name) === MARKER_PATH;
  const literal = (node: ts.Node | undefined): string | undefined =>
    node &&
    (ts.isStringLiteralLike(node) || ts.isNoSubstitutionTemplateLiteral(node))
      ? node.text
      : undefined;
  const fail = (node: ts.Node, message: string) =>
    errors.push(
      `${name}:${file.getLineAndCharacterOfPosition(node.getStart(file)).line + 1}: ${message}`,
    );
  const visit = (node: ts.Node) => {
    if (
      ts.isImportSpecifier(node) &&
      /^(inlineProse|markRichProse)$/.test(node.propertyName?.text ?? "")
    )
      fail(node, "do not alias the prose helper");
    if (
      ts.isIdentifier(node) &&
      /^(inlineProse|markRichProse)$/.test(node.text) &&
      !(ts.isCallExpression(node.parent) && node.parent.expression === node) &&
      !ts.isImportSpecifier(node.parent) &&
      !(ts.isFunctionDeclaration(node.parent) && node.parent.name === node)
    )
      fail(node, "do not alias or hide the prose helper");
    if (
      ts.isElementAccessExpression(node) &&
      /^(inlineProse|markRichProse)$/.test(
        literal(node.argumentExpression) ?? "",
      )
    )
      fail(node, "do not hide the prose helper behind computed access");
    if (ts.isCallExpression(node)) {
      const callee = node.expression.getText(file);
      if (
        callee === "Object.assign" &&
        /\.(?:style|dataset)$/.test(node.arguments[0]?.getText(file) ?? "")
      )
        fail(node, "opaque style writes cannot opt out of target rules");

      if (
        /\.classList\.(?:add|remove|toggle|replace)$/.test(callee) &&
        !inDom &&
        node.arguments.some((arg, i) => {
          if (callee.endsWith(".toggle") && i > 0) return false;
          return !literal(arg) || /^(?:inline-prose|sr)$/.test(literal(arg)!);
        })
      )
        fail(node, "reserved prose classes belong to the helper");

      if (callee === "inlineProse") {
        const reason = literal(node.arguments[0]);
        if (!reason || reason.trim().length < 12)
          fail(node, "inline prose needs a literal reason");
        // Null represents a link. Each variant keeps direct sibling order.
        type Part = string | null;
        const combine = (left: Part[][], right: Part[][]): Part[][] =>
          left.length * right.length > 64
            ? []
            : left.flatMap((a) => right.map((b) => [...a, ...b]));
        const textVariants = (value: ts.Expression): string[] => {
          const fixed = literal(value);
          if (fixed !== undefined) return [fixed];
          if (ts.isConditionalExpression(value)) {
            const yes = textVariants(value.whenTrue),
              no = textVariants(value.whenFalse);
            return yes.length && no.length ? [...yes, ...no] : [];
          }
          if (ts.isTemplateExpression(value))
            return [
              value.head.text +
                value.templateSpans
                  .map((part) => " " + part.literal.text)
                  .join(""),
            ];
          return [];
        };
        const childVariants = (args: readonly ts.Expression[]): Part[][] => {
          let result: Part[][] = [[]];
          for (const arg of args) {
            let variants: Part[][] = [];
            if (ts.isSpreadElement(arg)) {
              const call = arg.expression;
              const callback = ts.isCallExpression(call)
                ? call.arguments[0]
                : undefined;
              // A flatMap can produce only inspectable direct child arrays.
              if (
                ts.isCallExpression(call) &&
                ts.isPropertyAccessExpression(call.expression) &&
                call.expression.name.text === "flatMap" &&
                call.arguments.length === 1 &&
                callback &&
                ts.isArrowFunction(callback) &&
                ts.isArrayLiteralExpression(callback.body)
              ) {
                const one = childVariants(callback.body.elements);
                variants = [...one, ...combine(one, one)];
              }
            } else if (ts.isCallExpression(arg)) {
              const helper = arg.expression.getText(file);
              if (helper === "text" && arg.arguments.length === 1)
                variants = textVariants(arg.arguments[0]).map((value) => [
                  value,
                ]);
              else if (/^(?:link|identityLink)$/.test(helper))
                variants = [[null]];
            }
            if (!variants.length) return [];
            result = combine(result, variants);
          }
          return result;
        };
        const variants = childVariants(node.arguments.slice(1));
        if (!variants.length)
          fail(node, "inline prose needs visible direct sentence children");
        for (const parts of variants) {
          let copy = "";
          const links: { start: number; end: number }[] = [];
          for (const part of parts) {
            if (part === null) {
              const start = copy.length;
              copy += "link";
              links.push({ start, end: copy.length });
            } else copy += part;
          }
          if (!sentenceLinks(copy, links))
            fail(
              node,
              "each inline link needs its own complete sentence with visible prose",
            );
        }
      }
      if (callee === "markRichProse") {
        if (
          !inMarkers ||
          !literal(node.arguments[1]) ||
          literal(node.arguments[1])!.trim().length < 12
        )
          fail(
            node,
            "dynamic prose needs the approved renderer and a literal reason",
          );
      }
      if (/\.(?:createElement|createElementNS)$/.test(callee) && !inDom)
        fail(node, "create elements through the shared DOM helper");
      if (
        /\.insertAdjacentHTML$/.test(callee) ||
        /^document\.(?:write|writeln)$/.test(callee)
      )
        fail(node, "raw markup can bypass target rules");
      if (
        /\.setAttribute$/.test(callee) &&
        /^(?:class|style|data-inline-prose-reason|data-inline-place-reason)$/.test(
          literal(node.arguments[0]) ?? "style",
        )
      )
        if (
          !(
            inDom &&
            (callee === "node.setAttribute" ||
              (callee === "svg.setAttribute" &&
                literal(node.arguments[0]) === "class"))
          )
        )
          fail(node, "use the shared target or reasoned helper");
      if (
        /\.style\.setProperty$/.test(callee) &&
        (!literal(node.arguments[0]) ||
          protectedProperties.test(
            (literal(node.arguments[0]) ?? "").toLowerCase(),
          ) ||
          literal(node.arguments[2]) === "important")
      )
        fail(node, "style API cannot opt out of target rules");
      if (
        callee === "el" &&
        literal(node.arguments[0]) === "input" &&
        node.arguments[1] &&
        ts.isObjectLiteralExpression(node.arguments[1])
      ) {
        const type = node.arguments[1].properties.find(
          (p) => ts.isPropertyAssignment(p) && p.name.getText(file) === "type",
        ) as ts.PropertyAssignment | undefined;
        if (/^(checkbox|radio)$/.test(literal(type?.initializer) ?? "")) {
          const variable =
            ts.isVariableDeclaration(node.parent) &&
            ts.isIdentifier(node.parent.name)
              ? node.parent.name.text
              : null;
          let scope: ts.Node = node;
          while (scope.parent && !ts.isBlock(scope) && !ts.isSourceFile(scope))
            scope = scope.parent;
          const idProperty = (
            node.arguments[1] as ts.ObjectLiteralExpression
          ).properties.find(
            (p) => ts.isPropertyAssignment(p) && p.name.getText(file) === "id",
          ) as ts.PropertyAssignment | undefined;
          const inputId = literal(idProperty?.initializer);
          let associated = 0;
          const labels = (part: ts.Node) => {
            if (
              ts.isCallExpression(part) &&
              part.expression.getText(file) === "el" &&
              literal(part.arguments[0]) === "label"
            ) {
              const wraps = part.arguments
                .slice(2)
                .some((arg) => ts.isIdentifier(arg) && arg.text === variable);
              const attributes = part.arguments[1];
              const forProperty =
                attributes && ts.isObjectLiteralExpression(attributes)
                  ? (attributes.properties.find(
                      (p) =>
                        ts.isPropertyAssignment(p) &&
                        p.name.getText(file) === "for",
                    ) as ts.PropertyAssignment | undefined)
                  : undefined;
              const external =
                inputId !== undefined &&
                literal(forProperty?.initializer) === inputId;
              if (wraps || external) associated++;
            }
            ts.forEachChild(part, labels);
          };
          labels(scope);
          if (associated !== 1)
            fail(node, "a checkbox or radio needs one associated label");
        }
      }
    }
    if (ts.isPropertyAssignment(node)) {
      const key = node.name.getText(file).replace(/^['"]|['"]$/g, "");
      if (
        ts.isComputedPropertyName(node.name) &&
        ts.isCallExpression(node.parent.parent) &&
        /^(?:el|link|button)$/.test(node.parent.parent.expression.getText(file))
      )
        fail(node, "DOM attribute names must be inspectable");

      if (/^(data-inline-prose-reason|data-inline-place-reason)$/.test(key)) {
        const allowed =
          key === "data-inline-prose-reason"
            ? inDom
            : inMarkers &&
              (literal(node.initializer)?.trim().length ?? 0) >= 12;
        if (!allowed)
          fail(node, "reason markers belong to their shared helper");
      }
      if (
        key === "class" &&
        literal(node.initializer)?.split(/\s+/).includes("inline-prose") &&
        !inDom
      )
        fail(node, "mark complete prose through inlineProse with a reason");
      if (
        key === "class" &&
        literal(node.initializer)?.split(/\s+/).includes("sr")
      ) {
        const object = node.parent;
        const call = object.parent;
        if (
          ts.isCallExpression(call) &&
          (call.expression.getText(file) === "link" ||
            call.expression.getText(file) === "button" ||
            (call.expression.getText(file) === "el" &&
              /^(?:a|button|input|select|textarea|summary)$/.test(
                literal(call.arguments[0]) ?? "",
              )))
        )
          fail(node, "interactive targets cannot use hidden-text clipping");
      }
      if (
        key === "class" &&
        !inDom &&
        ts.isCallExpression(node.parent.parent)
      ) {
        const call = node.parent.parent;
        const interactive =
          /^(?:link|button)$/.test(call.expression.getText(file)) ||
          (call.expression.getText(file) === "el" &&
            /^(?:a|button|input|select|textarea|summary)$/.test(
              literal(call.arguments[0]) ?? "",
            ));
        if (interactive) {
          const choices = (part: ts.Expression): string[] | null => {
            const value = literal(part);
            if (value !== undefined) return [value];
            if (ts.isConditionalExpression(part)) {
              const yes = choices(part.whenTrue),
                no = choices(part.whenFalse);
              return yes && no && yes.length + no.length <= 64
                ? [...yes, ...no]
                : null;
            }
            if (ts.isTemplateExpression(part)) {
              let values = [part.head.text];
              for (const span of part.templateSpans) {
                const alternatives = choices(span.expression);
                if (!alternatives || values.length * alternatives.length > 64)
                  return null;
                values = values.flatMap((prefix) =>
                  alternatives.map(
                    (value) => prefix + value + span.literal.text,
                  ),
                );
              }
              return values;
            }
            return null;
          };
          const alternatives = choices(node.initializer);
          if (
            !alternatives ||
            alternatives.some((value) =>
              value
                .split(/\s+/)
                .some((token) => /^(?:sr|inline-prose)$/.test(token)),
            )
          )
            fail(
              node,
              "interactive class alternatives must be visible and inspectable",
            );
        }
      }
      if (key === "style") {
        const values: string[] = [];
        const styleValues = (part: ts.Expression): boolean => {
          const value = literal(part);
          if (value !== undefined) {
            values.push(value);
            return true;
          }
          if (
            part.kind === ts.SyntaxKind.Identifier &&
            part.getText(file) === "undefined"
          )
            return true;
          if (ts.isConditionalExpression(part))
            return styleValues(part.whenTrue) && styleValues(part.whenFalse);
          if (ts.isTemplateExpression(part)) {
            // Dynamic percentages can change a value, never a property or declaration.
            if (
              !part.templateSpans.every(
                (span) =>
                  !ts.isIdentifier(span.expression) &&
                  !ts.isStringLiteralLike(span.expression),
              )
            )
              return false;
            values.push(
              part.head.text +
                part.templateSpans
                  .map((span) => "0" + span.literal.text)
                  .join(""),
            );
            return true;
          }
          return false;
        };
        if (!styleValues(node.initializer))
          fail(node, "target styles must be inspectable");
        for (const value of values) {
          const css = postcss.parse(`x {${value}}`);
          css.walkDecls((decl) => {
            decl.prop = decl.prop.toLowerCase();

            if (
              (decl.important && protectedProperties.test(decl.prop)) ||
              decl.prop === "all" ||
              /^(?:transform|scale|zoom|clip|clip-path)$/.test(
                decl.prop.toLowerCase(),
              ) ||
              (decl.prop === "display" && !SAFE_DISPLAY.test(decl.value))
            )
              fail(node, "inline style cannot opt out of target rules");
          });
        }
      }
    }
    if (
      ts.isBinaryExpression(node) &&
      node.operatorToken.kind >= ts.SyntaxKind.FirstAssignment &&
      node.operatorToken.kind <= ts.SyntaxKind.LastAssignment
    ) {
      const left = node.left.getText(file);
      if (
        (ts.isPropertyAccessExpression(node.left) &&
          node.left.name.text === "style") ||
        (ts.isElementAccessExpression(node.left) &&
          literal(node.left.argumentExpression) === "style")
      )
        fail(node, "direct style assignment cannot opt out of target rules");
      if (
        !inDom &&
        /dataset/.test(left) &&
        (/inlineProseReason|inlinePlaceReason/.test(left) || /\[/.test(left))
      )
        fail(node, "reserved prose reasons belong to the helper");
      if (/\.style\[/.test(left))
        fail(node, "computed style writes cannot opt out of target rules");

      if (
        /\.(?:innerHTML|outerHTML)$/.test(left) &&
        !(inDom && left === "svg.innerHTML")
      )
        fail(node, "raw markup can bypass target rules");
      if (
        /\.style\.(?:minWidth|minHeight|minInlineSize|minBlockSize|display|cssText|transform|scale|zoom|all|clip|clipPath)$/.test(
          left,
        ) &&
        !(inDom && left === "node.style.cssText") &&
        literal(node.right) !== "inline-flex"
      )
        fail(node, "style assignment cannot opt out of target rules");
      if (
        /\.className$/.test(left) &&
        literal(node.right)
          ?.split(/\s+/)
          .some((value) => value === "inline-prose" || value === "sr")
      )
        fail(node, "use inlineProse with a source reason");
    }
    ts.forEachChild(node, visit);
  };
  visit(file);
  return errors;
}
