import {parse} from "gitlab://jamesxt94/codes@465eb5ab/cli-params.ts"
import {kawix} from "github://kwruntime/core@b9d4a6a/src/kwruntime.ts"
import {Manager, Config} from './manager.ts'
import Os from 'os'
import Path from 'path'

// TEST SCRIPT
// NOT FOR USE

export class Program{


	static async main(){

		let cli = parse()
		let cpus = Os.cpus().length
		if(cli.params.clusters){
			cpus = Number(cli.params.clusters)
		}

		let config:Config = {
			id: cli.params.id || "default",
			cpus,
			host: cli.params.host || "0.0.0.0",
			port: Number(cli.params.port) || 8080
		}
		if(cli.params.httpsPort){
			config.https_port = Number(cli.params.httpsPort)
		}
		if(cli.params.rootMode){
			config.startup = {
				asroot: true 
			}
		}

		if(cli.params.ssl){
			config.ssl = cli.params.ssl
		}
		


		let manager = new Manager(config )
		manager.on("cluster-address", function(event){
			console.info("> Subprocess:", event.id, "Listening on:", event.address)
		})
		manager.on("tmux-started", function(){
			console.info("> Tmux started")
		})
		manager.on("caddy-started", function(){
			console.info("> Caddy web server started")
		})
		manager.on("error", function(e){
			console.info("> Error on service:", e)
		})
		await manager.startServer()


		//await dynwRoute.start(manager)


		

	}

}



