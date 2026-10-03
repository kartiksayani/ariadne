use serde::Deserialize;
use std::collections::{BTreeMap, BTreeSet};
use syn::ext::IdentExt;
use syn::{Attribute, Expr, Fields, GenericArgument, Item, Meta, PathArguments, Type, UseTree};

type Check<T> = Result<T, String>;
#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
pub struct Request {
    pub sources: BTreeMap<String, String>,
    pub roots: Vec<String>,
    pub inventory: BTreeSet<String>,
}
const PROTECTED: &[&str] = &[
    "core",
    "std",
    "serde",
    "schemars",
    "ts_rs",
    "Debug",
    "PartialEq",
    "Eq",
    "Clone",
    "Serialize",
    "Deserialize",
    "JsonSchema",
    "TS",
];

fn path_names(path: &syn::Path) -> Vec<String> {
    path.segments
        .iter()
        .map(|part| part.ident.unraw().to_string())
        .collect()
}
fn simple_path(path: &syn::Path) -> bool {
    path.segments
        .iter()
        .all(|part| matches!(part.arguments, PathArguments::None))
}
fn data_type(ty: &Type) -> Check<()> {
    let Type::Path(path) = ty else {
        return Err("unsupported data type syntax".into());
    };
    if path.qself.is_some() {
        return Err("qualified associated type is unsupported".into());
    }
    let names = path_names(&path.path).join("::");
    let count = match names.as_str() {
        "Option" | "Vec" => Some(1),
        "std::collections::BTreeMap" if path.path.leading_colon.is_some() => Some(2),
        "chrono::DateTime" if path.path.leading_colon.is_some() => Some(1),
        _ => None,
    };
    if let Some(count) = count {
        let last = path.path.segments.last().ok_or("empty type path")?;
        let PathArguments::AngleBracketed(arguments) = &last.arguments else {
            return Err("container requires type arguments".into());
        };
        if arguments.colon2_token.is_some()
            || arguments.args.len() != count
            || path
                .path
                .segments
                .iter()
                .rev()
                .skip(1)
                .any(|s| !matches!(s.arguments, PathArguments::None))
        {
            return Err("unsupported container arguments".into());
        }
        for argument in &arguments.args {
            let GenericArgument::Type(ty) = argument else {
                return Err("only type arguments are permitted".into());
            };
            data_type(ty)?;
        }
        if names == "chrono::DateTime"
            && !matches!(arguments.args.first(), Some(GenericArgument::Type(Type::Path(p))) if p.qself.is_none() && p.path.leading_colon.is_some() && simple_path(&p.path) && path_names(&p.path).join("::") == "chrono::Utc")
        {
            return Err("only UTC DateTime is demonstrated".into());
        }
        if names == "std::collections::BTreeMap"
            && !matches!(arguments.args.first(), Some(GenericArgument::Type(Type::Path(p))) if p.qself.is_none() && p.path.is_ident("String"))
        {
            return Err("map keys must be String".into());
        }
    } else if !simple_path(&path.path)
        || !(path.path.leading_colon.is_none()
            && (path.path.segments.len() == 1
                || matches!(
                    path.path
                        .segments
                        .first()
                        .map(|s| s.ident.unraw().to_string())
                        .as_deref(),
                    Some("crate" | "self" | "super")
                ))
            || path.path.leading_colon.is_some()
                && matches!(names.as_str(), "uuid::Uuid" | "chrono::Utc"))
    {
        return Err("unsupported plain DTO type path".into());
    }
    Ok(())
}

#[derive(Clone, Copy)]
enum Context {
    Docs,
    Struct,
    Enum,
    Range,
}
fn attributes(
    attrs: &[Attribute],
    context: Context,
    providers: &mut BTreeSet<String>,
) -> Check<()> {
    let mut seen = BTreeSet::new();
    for attr in attrs {
        if !matches!(attr.style, syn::AttrStyle::Outer) {
            return Err("inner attributes are unsupported".into());
        }
        if attr.path().is_ident("doc") {
            if !matches!(&attr.meta, Meta::NameValue(v) if matches!(&v.value, Expr::Lit(e) if e.attrs.is_empty() && matches!(e.lit, syn::Lit::Str(_))))
            {
                return Err("doc must be a literal string".into());
            }
        } else if attr.path().is_ident("derive")
            && matches!(context, Context::Struct | Context::Enum)
        {
            let paths = attr
                .parse_args_with(
                    syn::punctuated::Punctuated::<syn::Path, syn::Token![,]>::parse_terminated,
                )
                .map_err(|e| e.to_string())?;
            if paths.is_empty() {
                return Err("empty derive list".into());
            }
            for path in paths {
                let name = path_names(&path).join("::");
                if path.leading_colon.is_none()
                    || !simple_path(&path)
                    || !seen.insert(format!("derive:{name}"))
                {
                    return Err("derive must have a distinct qualified identity".into());
                }
                match name.as_str() {
                    "core::fmt::Debug"
                    | "core::cmp::PartialEq"
                    | "core::cmp::Eq"
                    | "core::clone::Clone" => {}
                    "serde::Serialize"
                    | "serde::Deserialize"
                    | "schemars::JsonSchema"
                    | "ts_rs::TS" => {
                        providers.insert(name.split("::").next().unwrap().into());
                    }
                    _ => return Err("unknown derive identity".into()),
                }
            }
        } else if attr.path().is_ident("serde")
            && matches!(context, Context::Struct | Context::Enum)
        {
            let before = seen.len();
            attr.parse_nested_meta(|meta| {
                let name = path_names(&meta.path).join("::");
                if !simple_path(&meta.path)
                    || meta.path.leading_colon.is_some()
                    || !seen.insert(format!("serde:{name}"))
                {
                    return Err(meta.error("duplicate/invalid serde option"));
                }
                if name == "deny_unknown_fields" {
                    return Ok(());
                }
                if matches!(context, Context::Enum) && matches!(name.as_str(), "tag" | "rename_all")
                {
                    let value: syn::LitStr = meta.value()?.parse()?;
                    let expected = if name == "tag" { "status" } else { "camelCase" };
                    if value.value() == expected {
                        return Ok(());
                    }
                }
                Err(meta.error("unsupported serde option"))
            })
            .map_err(|e| e.to_string())?;
            if seen.len() == before {
                return Err("empty serde options".into());
            }
        } else if attr.path().is_ident("schemars") && matches!(context, Context::Range) {
            let before = seen.len();
            attr.parse_nested_meta(|meta| {
                if !meta.path.is_ident("range") || !seen.insert("schemars:range".into()) {
                    return Err(meta.error("only range is permitted"));
                }
                let mut bounds = BTreeSet::new();
                meta.parse_nested_meta(|bound| {
                    let key = path_names(&bound.path).join("::");
                    let value: syn::LitInt = bound.value()?.parse()?;
                    if !bounds.insert(key.clone())
                        || !((key == "min"
                            && value.base10_digits() == "1"
                            && value.suffix().is_empty())
                            || (key == "max"
                                && value.base10_digits() == "9007199254740991"
                                && value.suffix() == "u64"))
                    {
                        return Err(bound.error("only exact safe integer bounds are permitted"));
                    }
                    Ok(())
                })?;
                if bounds.len() != 2 {
                    return Err(meta.error("both safe integer bounds are required"));
                }
                Ok(())
            })
            .map_err(|e| e.to_string())?;
            if seen.len() == before {
                return Err("empty schemars options".into());
            }
        } else {
            return Err("unsupported attribute".into());
        }
    }
    Ok(())
}
fn fields(fields: &Fields, providers: &mut BTreeSet<String>) -> Check<()> {
    for field in fields {
        data_type(&field.ty)?;
        let context = if matches!(fields, Fields::Unnamed(f) if f.unnamed.len() == 1)
            && matches!(&field.ty, Type::Path(p) if p.qself.is_none() && p.path.is_ident("u64"))
        {
            Context::Range
        } else {
            Context::Docs
        };
        attributes(&field.attrs, context, providers)?;
    }
    Ok(())
}
fn generics(generics: &syn::Generics) -> Check<()> {
    if !generics.params.is_empty() || generics.where_clause.is_some() {
        return Err("generic declarations are unsupported".into());
    }
    Ok(())
}
fn reexport(tree: &UseTree, prefix: Option<&str>) -> Check<()> {
    match tree {
        UseTree::Path(path) => reexport(&path.tree, Some(&path.ident.unraw().to_string())),
        UseTree::Name(name) => {
            let name = name.ident.unraw().to_string();
            let binding = if name == "self" {
                prefix.unwrap_or("self")
            } else {
                &name
            };
            if PROTECTED.contains(&binding) {
                return Err("reexport binds a protected name".into());
            }
            Ok(())
        }
        UseTree::Group(group) => {
            for item in &group.items {
                reexport(item, prefix)?;
            }
            Ok(())
        }
        _ => Err("reexport aliases/globs are unsupported".into()),
    }
}
struct Parsed {
    modules: Vec<String>,
    facade: bool,
    providers: BTreeSet<String>,
}
fn parse(source: &str) -> Check<Parsed> {
    let file = syn::parse_file(source).map_err(|e| e.to_string())?;
    if file.shebang.is_some() || !file.attrs.is_empty() {
        return Err("file attributes/shebang are unsupported".into());
    }
    let mut result = Parsed {
        modules: vec![],
        facade: true,
        providers: BTreeSet::new(),
    };
    let mut imports = false;
    for item in file.items {
        let providers = &mut result.providers;
        match item {
            Item::Mod(m)
                if matches!(m.vis, syn::Visibility::Public(_))
                    && m.content.is_none()
                    && m.unsafety.is_none()
                    && m.semi.is_some()
                    && !PROTECTED.contains(&m.ident.unraw().to_string().as_str()) =>
            {
                attributes(&m.attrs, Context::Docs, providers)?;
                result.modules.push(m.ident.unraw().to_string());
                imports = true;
            }
            Item::Use(u) if matches!(u.vis, syn::Visibility::Public(_)) => {
                attributes(&u.attrs, Context::Docs, providers)?;
                reexport(&u.tree, None)?;
                imports = true;
            }
            Item::Struct(s) if matches!(s.vis, syn::Visibility::Public(_)) => {
                generics(&s.generics)?;
                attributes(&s.attrs, Context::Struct, providers)?;
                fields(&s.fields, providers)?;
                result.facade = false;
            }
            Item::Enum(e) if matches!(e.vis, syn::Visibility::Public(_)) => {
                generics(&e.generics)?;
                attributes(&e.attrs, Context::Enum, providers)?;
                for variant in e.variants {
                    if variant.discriminant.is_some() {
                        return Err("enum discriminants are unsupported".into());
                    }
                    attributes(&variant.attrs, Context::Docs, providers)?;
                    fields(&variant.fields, providers)?;
                }
                result.facade = false;
            }
            Item::Type(t) if matches!(t.vis, syn::Visibility::Public(_)) => {
                generics(&t.generics)?;
                attributes(&t.attrs, Context::Docs, providers)?;
                data_type(&t.ty)?;
                result.facade = false;
            }
            _ => return Err("unsupported Rust item".into()),
        }
    }
    if imports && !result.facade {
        return Err("DTO cannot contain modules or imports".into());
    }
    Ok(result)
}
fn child(parent: &str, module: &str, inventory: &BTreeSet<String>) -> Check<String> {
    let path = std::path::Path::new(parent);
    let directory = if matches!(
        path.file_name().and_then(|n| n.to_str()),
        Some("lib.rs" | "mod.rs")
    ) {
        path.parent().ok_or("module has no parent")?.to_path_buf()
    } else {
        path.with_extension("")
    };
    let choices = [
        directory.join(format!("{module}.rs")),
        directory.join(module).join("mod.rs"),
    ];
    let existing: Vec<_> = choices
        .iter()
        .map(|p| p.to_string_lossy().into_owned())
        .filter(|p| inventory.contains(p))
        .collect();
    if existing.len() != 1 {
        return Err("module source is missing or ambiguous".into());
    }
    Ok(existing[0].clone())
}
fn walk(
    name: &str,
    parsed: &BTreeMap<String, Parsed>,
    inventory: &BTreeSet<String>,
    visited: &mut BTreeSet<String>,
) -> Check<()> {
    if !visited.insert(name.into()) {
        return Err("duplicate module reachability".into());
    }
    let node = parsed
        .get(name)
        .ok_or("module ancestor is not SHA-classified")?;
    for module in &node.modules {
        let path = child(name, module, inventory)?;
        if parsed.contains_key(&path) {
            walk(&path, parsed, inventory, visited)?;
        } else if parsed.keys().any(|p| {
            p.starts_with(&format!(
                "{}/",
                path.trim_end_matches(".rs").trim_end_matches("/mod")
            ))
        }) {
            return Err("module ancestor is not SHA-classified".into());
        }
    }
    Ok(())
}
pub fn verify(request: Request) -> Check<BTreeMap<String, Vec<String>>> {
    let mut parsed = BTreeMap::new();
    for (name, source) in request.sources {
        if !request.inventory.contains(&name) {
            return Err("classified source is absent from inventory".into());
        }
        let file = parse(&source).map_err(|e| format!("{name}: {e}"))?;
        parsed.insert(name, file);
    }
    let mut visited = BTreeSet::new();
    for root in request.roots {
        if let Some(node) = parsed.get(&root) {
            if !node.facade {
                return Err("crate root must be a verified facade".into());
            }
            walk(&root, &parsed, &request.inventory, &mut visited)?;
        }
    }
    if visited.len() != parsed.len() {
        return Err("classified source has no verified module ancestor chain".into());
    }
    Ok(parsed
        .into_iter()
        .map(|(name, p)| (name, p.providers.into_iter().collect()))
        .collect())
}
