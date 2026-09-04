use std::env;

use endor_git::{GitHashAlgorithm, GitObjectDb, GitObjectKind, Libgit2Repository};

fn main() -> Result<(), Box<dyn std::error::Error>> {
    let mut arguments = env::args_os();
    let _program = arguments.next();
    let Some(repository_path) = arguments.next() else {
        return Err("usage: endor-git-probe <bare-repository-path>".into());
    };
    if arguments.next().is_some() {
        return Err("usage: endor-git-probe <bare-repository-path>".into());
    }
    let repository =
        Libgit2Repository::initialize_bare(repository_path.as_ref(), GitHashAlgorithm::Sha256)?;
    let identifier = repository.write_object(GitObjectKind::Blob, b"endor-git-probe")?;
    let object = repository.read_object(&identifier)?;
    println!(
        "format={:?} object={} bytes={}",
        identifier.algorithm(),
        identifier,
        object.bytes.len()
    );
    Ok(())
}
