import subprocess

def check_js_syntax():
    try:
        # Run node -c (syntax check) on app.js
        result = subprocess.run(
            ['node', '-c', 'frontend/js/app.js'],
            capture_output=True,
            text=True,
            check=False
        )
        if result.returncode == 0:
            print("Syntax OK")
        else:
            print("Syntax Error:")
            print(result.stderr)
    except FileNotFoundError:
        print("Node not found on system")

if __name__ == '__main__':
    check_js_syntax()
