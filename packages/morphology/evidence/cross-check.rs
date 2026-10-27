use jvc_morphology::lujvo::*;
fn main() {
    let words=["aktyiismu","fuly'ismu","fulta'yismu","tcenelyiismu","gimyiismu","jenjigu'ydi'e","gimspageti","baurismu","leksiko'yismu","fulty'ismu","sairzba","sakrsakysakli","sabkysakli","rsakli","ntadi","ismu","zbasai","tosymabru","tosmabru","ckusni","cuktysni","ro'inre'o","saizba","sakrsakrsakrsakrsakrsakrsakrsakrsakli"];
    let mut evidence=vec![];
    for word in words {
        let jb=jbotci_morphology::segment_words_with_modifiers(word);
        let jb_parts=jbotci_morphology::parse_lujvo_word_parts(word);
        println!("{word}: jbotci={jb:?} parts={jb_parts:?}");
        let kind=match &jb {
            Ok(items) if items.len()==1 => match items[0].bare_word() { Some(w) => match w.kind() {
                jbotci_morphology::WordKind::Gismu=>"gismu",jbotci_morphology::WordKind::Lujvo=>"lujvo",jbotci_morphology::WordKind::Fuhivla=>"fuhivla",jbotci_morphology::WordKind::Cmavo=>"cmavo",jbotci_morphology::WordKind::Cmevla=>"cmevla",
            }, _=>"unknown" }, _=>"unknown"
        };
        let tokens=jb_parts.as_ref().map(|ps|ps.iter().map(|p|p.phonemes().as_str().chars().map(|c|match c {'á'=>'a','é'=>'e','í'|'ĭ'=>'i','ó'=>'o','ú'|'ŭ'=>'u','ý'=>'y',_=>c}).collect::<String>()).collect::<Vec<_>>()).unwrap_or_default();
        let mut row=serde_json::json!({"word":word,"jbotci_kind":kind,"jbotci_tokens":tokens});
        for (name,profile) in [("cll-ebnf",Profile::Cll),("bpfk",Profile::Extended)] {
            let r=gencmu::load_dialect(name).unwrap().parse(word,&gencmu::ParseOptions::default()).unwrap();
            row[name]=serde_json::json!({"ok":r.ok,"brackets":gencmu::to_brackets(&r,false)});
            let ours=analyze_word(profile,word);
            println!("{name}: gencmu_ok={} gencmu={} jvc={}",r.ok,gencmu::to_brackets(&r,false),serde_json::to_string(&ours).unwrap());
        }
        evidence.push(row);
    }
    println!("REFERENCE_JSON={}",serde_json::to_string(&evidence).unwrap());
    for n in [8,12,16,24,30] {
        let word=format!("{}sakli","sakr".repeat(n));let start=std::time::Instant::now();
        let r=analyze_word(Profile::Cll,&word);
        println!("budget n={n} elapsed={:?} result={:?} {:?}",start.elapsed(),r.kind,r.diagnostics);
    }
}
