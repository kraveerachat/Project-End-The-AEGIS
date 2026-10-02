import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import fs from 'node:fs'
import path from 'node:path'
import test from 'node:test'
import { fileURLToPath } from 'node:url'

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..')
const runtime = path.join(root, 'deploy/idea2/h1-runtime')
const read = name => fs.readFileSync(path.join(runtime, name), 'utf8')

function pythonCommand() {
  if (process.env.AEGIS_TEST_PYTHON) return [process.env.AEGIS_TEST_PYTHON]
  for (const candidate of [['python'], ['py', '-3']]) {
    if (spawnSync(candidate[0], [...candidate.slice(1), '--version'], { encoding: 'utf8' }).status === 0) return candidate
  }
  return null
}

function runPython(python, source, mode) {
  const env = { ...process.env }
  delete env.AEGIS_H1_N1_DOCKER_MODE
  if (mode !== undefined) env.AEGIS_H1_N1_DOCKER_MODE = mode
  return spawnSync(python[0], [...python.slice(1), '-c', source, runtime], {
    encoding: 'utf8', env, cwd: root,
  })
}

test('N1 Docker mode defaults to direct and rejects unknown execution modes', t => {
  const python = pythonCommand()
  if (!python) return t.skip('Python unavailable')
  const source = 'import sys; sys.path.insert(0,sys.argv[1]); from docker_exec import docker_command; print(docker_command("compose","config","--quiet"))'
  const direct = runPython(python, source)
  assert.equal(direct.status, 0, direct.stderr)
  assert.equal(direct.stdout.trim(), "['docker', '--host', 'unix:///var/run/docker.sock', 'compose', 'config', '--quiet']")
  const invalid = runPython(python, source, 'sudo-E')
  assert.notEqual(invalid.status, 0)
  assert.doesNotMatch(invalid.stdout, /\['docker'/)
})

test('N1 sudo mode prefixes Docker only with noninteractive sudo and removes DOCKER_HOST', t => {
  const python = pythonCommand()
  if (!python) return t.skip('Python unavailable')
  const source = 'import sys; sys.path.insert(0,sys.argv[1]); from docker_exec import docker_command; print(docker_command("compose","config","--quiet"))'
  const result = runPython(python, source, 'sudo-noninteractive')
  assert.equal(result.status, 0, result.stderr)
  assert.equal(result.stdout.trim(), "['sudo', '-n', 'env', '-u', 'DOCKER_HOST', 'docker', '--host', 'unix:///var/run/docker.sock', 'compose', 'config', '--quiet']")
  assert.doesNotMatch(result.stdout, /sudo -E/)
})

test('N1 live validator captures Compose JSON in memory and elevates only the Docker child', t => {
  const python = pythonCommand()
  if (!python) return t.skip('Python unavailable')
  const source = `
import contextlib, io, json, os, pathlib, sys, tempfile, types
sys.path.insert(0, sys.argv[1])
import validate
with tempfile.TemporaryDirectory() as directory:
    env_file = pathlib.Path(directory) / "h1.env"
    env_file.write_text("SECRET=fixture-private\\n", encoding="utf-8")
    env_file.chmod(0o600)
    commands = []
    validate.check_reviewed_checkout = lambda sha: None
    validate.check = lambda rendered, sha: None
    def fake_run(command, **kwargs):
        commands.append(command)
        assert kwargs["capture_output"] and kwargs["text"]
        return types.SimpleNamespace(returncode=0, stdout=json.dumps({"secret": "fixture-private"}))
    validate.subprocess.run = fake_run
    sys.argv = ["validate.py", "--source-sha", "a" * 40, "--env-file", str(env_file)]
    output = io.StringIO()
    with contextlib.redirect_stdout(output):
        result = validate.main()
    assert result == 0
    assert output.getvalue().strip() == "H1_N1_CONFIG_VALIDATION=PASS"
    assert len(commands) == 1
    assert commands[0][:9] == ["sudo", "-n", "env", "-u", "DOCKER_HOST", "docker", "--host", "unix:///var/run/docker.sock", "compose"]
    assert commands[0][-3:] == ["config", "--format", "json"]
    print("PASS")
`
  const result = runPython(python, source, 'sudo-noninteractive')
  assert.equal(result.status, 0, result.stderr)
  assert.equal(result.stdout.trim(), 'PASS')
})

test('N1 checkout guard rejects client-selected Docker host and context before Docker calls', t => {
  const python = pythonCommand()
  if (!python) return t.skip('Python unavailable')
  const source = `
import os,sys
sys.path.insert(0,sys.argv[1])
import validate
for key in ("DOCKER_HOST", "DOCKER_CONTEXT"):
    os.environ[key] = "unreviewed"
    try:
        validate.check_reviewed_checkout("a" * 40)
    except ValueError as error:
        assert "remote Docker override forbidden" in str(error)
    else:
        raise AssertionError(key + " was accepted")
    del os.environ[key]
print("PASS")
`
  const result = runPython(python, source, 'sudo-noninteractive')
  assert.equal(result.status, 0, result.stderr)
  assert.equal(result.stdout.trim(), 'PASS')
})

test('N1 live validation rejects root Python before owner-file or Docker validation', t => {
  const python = pythonCommand()
  if (!python) return t.skip('Python unavailable')
  const source = `
import sys
from unittest.mock import patch
sys.path.insert(0,sys.argv[1])
import validate
with patch.object(validate.os, "geteuid", return_value=0, create=True):
    try:
        validate.ensure_unprivileged_python()
    except ValueError as error:
        assert "must not run as root" in str(error)
    else:
        raise AssertionError("root Python accepted")
print("PASS")
`
  const result = runPython(python, source, 'sudo-noninteractive')
  assert.equal(result.status, 0, result.stderr)
  assert.equal(result.stdout.trim(), 'PASS')
})

test('N1 validation never prints exception text from rendered secret data', t => {
  const python = pythonCommand()
  if (!python) return t.skip('Python unavailable')
  const source = `
import contextlib,io,pathlib,sys,tempfile,types
sys.path.insert(0,sys.argv[1])
import validate
with tempfile.TemporaryDirectory() as directory:
    env_file=pathlib.Path(directory)/"h1.env"
    env_file.write_text("SECRET=fixture-private\\n",encoding="utf-8")
    env_file.chmod(0o600)
    validate.check_reviewed_checkout=lambda sha: None
    validate.subprocess.run=lambda *args,**kwargs: types.SimpleNamespace(returncode=0,stdout='{}')
    validate.check=lambda *args: validate.urlsplit("postgresql://monitor_h1_app@postgres:SECRET-MARKER/aegis_h1_lab").port
    sys.argv=["validate.py","--source-sha","a"*40,"--env-file",str(env_file)]
    output=io.StringIO()
    with contextlib.redirect_stdout(output):
        result=validate.main()
    assert result==2
    assert "SECRET-MARKER" not in output.getvalue()
    assert "H1_N1_CONFIG_VALIDATION=FAIL" in output.getvalue()
print("PASS")
`
  const result = runPython(python, source, 'sudo-noninteractive')
  assert.equal(result.status, 0, result.stderr)
  assert.equal(result.stdout.trim(), 'PASS')
})

test('N1 validator keeps checkout and owner-only secret checks in unprivileged Python', () => {
  const source = read('validate.py')
  assert.match(source, /check_reviewed_checkout\(args\.source_sha\)/)
  assert.match(source, /env_path\.stat\(\)\.st_uid == os\.getuid\(\)/)
  assert.match(source, /mode & 0o077 == 0/)
  assert.match(source, /docker_command\("compose",/)
  assert.doesNotMatch(source, /sudo -E|sudo.*git|sudo.*stat|setuid|seteuid|setgid|setegid/)
  assert.match(source, /not os\.environ\.get\("DOCKER_HOST"\) and not os\.environ\.get\("DOCKER_CONTEXT"\)/)
  assert.match(source, /capture_output=True/)
  assert.doesNotMatch(source, /print\(result\.stdout\)|print\(rendered\)/)
})

test('N1 README uses the reviewed host Docker prefix at every lifecycle boundary', () => {
  const readme = read('README.md')
  assert.match(readme, /sudo -v/)
  assert.match(readme, /AEGIS_H1_N1_DOCKER_MODE=sudo-noninteractive/)
  assert.equal((readme.match(/sudo -n env -u DOCKER_HOST docker --host unix:\/\/\/var\/run\/docker\.sock compose/g) || []).length, 4)
  assert.doesNotMatch(readme, /(^|\n)docker compose /)
  assert.doesNotMatch(readme, /^sudo -E|docker group|docker\.sock ACL/m)
})

test('N1 cleanup is print-only, project-scoped, and follows selected Docker mode', t => {
  const python = pythonCommand()
  if (!python) return t.skip('Python unavailable')
  const cleanup = read('cleanup.py')
  assert.doesNotMatch(cleanup, /subprocess\.run|subprocess\.Popen|os\.system|--volumes|system prune/)
  const result = runPython(python, 'import runpy,sys; sys.path.insert(0,sys.argv[1]); runpy.run_path(sys.argv[1]+"/cleanup.py",run_name="__main__")', 'sudo-noninteractive')
  assert.equal(result.status, 0, result.stderr)
  assert.match(result.stdout, /sudo -n env -u DOCKER_HOST docker --host unix:\/\/\/var\/run\/docker\.sock compose --project-name aegis-h1-lab/)
  assert.match(result.stdout, /sudo -n env -u DOCKER_HOST docker --host unix:\/\/\/var\/run\/docker\.sock volume rm aegis-h1-lab_postgres_data/)
  assert.doesNotMatch(result.stdout, /aegis-prod|docker system prune/)
})
