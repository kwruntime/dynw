// Distributed Node.js server
// with process instead of clusters, with automatic balancer (using caddy)

import {ModuleInfo, RouteModuleHandler, Server} from './server.ts'

import Os from 'os'
import {Caddy} from 'gitlab://jamesxt94/codes@48904da6/webservers/caddy/server.ts'
import {CaddyHttpRoute, CaddyHttpServer, CaddyRouteMatch} from 'gitlab://jamesxt94/codes@48904da6/webservers/caddy/types.ts'
import Path from 'path'
import fs from 'fs'
import crypto from 'crypto'
//import * as async from "gh+/kwruntime/std@1.1.4/util/async.ts"
import uniqid from "npm://uniqid@5.4.0"
import {Exception} from "gh+/kwruntime/std@4fe87b1/util/exception.ts"
import {AsyncEventEmitter} from "gh+/kwruntime/std@4fe87b1/async/events.ts"


import {Tmux} from "gitlab://jamesxt94/tmux@6187c824/src/v2/tmux.ts"
//emport {Tmux} from "/data/projects/Kodhe/tmux/src/v2/tmux.ts"


import {Server as MeshaServer} from 'gitlab://jamesxt94/mesha@2.0.2/src/server.ts'
import {Client} from 'gitlab://jamesxt94/mesha@2.0.2/src/clients/default.ts'
import {RPC} from 'gitlab://jamesxt94/mesha@2.0.2/src/rpc.ts'



import {parse} from "gitlab://jamesxt94/codes@88af0824/cli-params.ts"
import {kawix} from "github://kwruntime/core@68f0642/src/kwruntime.ts"



export interface RouteStaticHandler{
	path?: string 
	match?: Array<CaddyRouteMatch>
	native: true
	static: {
		root?: string
		path_prefix?: string 
	}
}

export interface RouteNativeHandler{
	native: true
	config?: CaddyHttpRoute
}

export interface RouteModuleNativeHandler extends RouteModuleHandler{
	match?: Array<CaddyRouteMatch>
	native: true
}

export type RouteHandler = RouteStaticHandler | RouteModuleHandler | RouteNativeHandler | RouteModuleNativeHandler


export interface Config extends HostConfig{
	id?: string
	cpus?: number
	startup?: {
		asroot?: boolean
	}
	hosts?: Array<HostConfig>
}

export interface HostConfig{
	host: string 
	names?: Array<string>,
	port?: number
	https_port?: number 
	ssl?: {
		automatic?: boolean 
		automate?: Array<string>
		key?: string 
		cert?: string 
	}
	upstreams?: [{
		dial: string
	}]
	config?: CaddyHttpServer
	routes?: Array<any>
}



const defaultConfig = {
	id: 'default',
	cpus: Os.cpus().length,
	host: "127.0.0.1"
}


export class Program{
	static async main(){
		try{
			let cli = parse()
			if(cli.params.cluster !== undefined){
				// start cluster 
				let serv = new Server()
				let addr = await serv.listen(cli.params.address, true)
				console.info("kmux:status:listen:", Buffer.from(JSON.stringify(addr)).toString('base64'),"$$")
				console.info("Server listen on:", addr)



				let server = new MeshaServer()
				server.on("error", console.error)
				server.shared.set("server", serv)

				

				/*
				server.on("client", (socket : ClientSocket)=>{
					let rpc = new RPC()
					rpc.channel = socket
					rpc.init()
					rpc.defaultScope.add("server", serv)
					socket.on("close", ()=>{
						rpc = null
					})
				})
				*/

				if(cli.params.dynwid){

					let client = new Client()
					await client.connect("local+" + cli.params.dynwid) 
					const rpc = client.rpc

					client.on("error",console.error)
					rpc.on("error",console.error)

					
					let manager = await rpc.defaultScope.remote("manager")
					serv.master = manager
					await manager.$addCluster(cli.params.id, serv)
				}

				
				await serv.init()
			}
		}catch(e){
			console.error("> Failed to execute:", e)
		}
	}
}




export class Router {
	#manager: Manager
	#routes: Array<RouteHandler> = []
	#defaults: Array<RouteHandler> = []
	#native: Array<RouteHandler> = []

	constructor(m:Manager){
		this.#manager = m 
	}

	


	get native(){
		return this.#native
	}

	add(handler: RouteHandler){
		if(handler["native"]){
			this.#native.push(handler)
			if(handler["module"]){
				handler["moduleId"] = uniqid()
				this.#routes.push(handler)
				this.#propagate()	
			}
			this.#manager.updateChanges()
		}
		else{
			this.#routes.push(handler)
			this.#propagate()
		}
		
	}

	addDefault(handler: RouteHandler){
		this.#defaults.push(handler)
		this.#propagate()		
	}

	remove(handler: RouteHandler){
		let i = this.#routes.indexOf(handler)
		let ok = false
		if(i >= 0){
			this.#routes.splice(i,1)
			ok = true 
		}
		else{
			i = this.#native.indexOf(handler)
			if(i >= 0){
				this.#native.splice(i,1)
				ok = true 
			}
			else{
				i = this.#defaults.indexOf(handler)
				if(i >= 0){
					this.#defaults.splice(i,1)
					ok = true 
				}	
			}
		}

		if(ok) this.#propagate()		
	}

	async #propagate(){
		if(this.#propagate["timer"]){
			clearTimeout(this.#propagate["timer"])
		}
		this.#propagate["timer"] = setTimeout(this.updateChanges.bind(this), 200)
	}

	

	async updateChanges(server?: Server){
		try{
			if(this.#propagate["timer"]){
				clearTimeout(this.#propagate["timer"])
			}
			let servers = this.#manager.servers 
			let keys = servers.keys()
			for(let key of keys){
				await this.$updateServer(servers.get(key))
			}
		}catch(e){
			let ex = Exception.create("Failed propagate routes: " + e.message, e).putCode("ROUTER_PROPAGATE_ERROR")
			this.#manager.emit("error", ex)
		}
	}

	protected async $updateServer(server?: Server){
		await server.setRoutes([...this.#routes, ...this.#defaults])
	}
}

export class Manager extends AsyncEventEmitter{

	#config: Config 
	#socket_addresses : Array<string>
	#rid : string 
	#cid : string 
	#caddy: Caddy
	#servers = new Map<string, Server>()
	#serverHandler : ModuleInfo 
	#startupHandler: ModuleInfo
	#router : Router
	#hosts = new Set<HostConfig>()
	#defaultRoute:any 

	client: Tmux

	startup = {
		url: '',
		method: ''
	}





	static getLocalId(id: string = 'default'){
		if((id.indexOf("/") >= 0) || (id.indexOf(":") >= 0)){
			id = crypto.createHash('md5').update(id).digest('hex')
		}
		let uid = "dynw-" + id
		let getId = (id: string) => `${process.env.USER}.kmux-${id}`
		return {
			id,
			uid,
			meshaId: getId(uid)
		}

	}


	constructor(config: Config){
		super()
		this.#config = Object.assign(defaultConfig, config)
		if(this.#config.hosts instanceof Array){
			for(let host of this.#config.hosts){
				this.#hosts.add(host)
			}
		}
		let res = Manager.getLocalId(this.#config.id)

		
		this.#cid = res.uid
		this.#caddy = new Caddy(this.#cid)
		this.#caddy.config.admin = {
			disabled: true
		}
		this.#rid = res.meshaId 
		
		if(Os.platform() == "win32"){
			// bind on TCP Ports, because named pipes are limited
			this.#socket_addresses = []
			for(let i=0;i<this.#config.cpus;i++){
				let num = parseInt(String(Math.random() * 200)) + 2
				this.#socket_addresses.push(`tcp://127.0.0.${num}:0`)
			}
		}
		else{

			// bind on unix sockets
			let folder = Path.join(Os.homedir(), ".kawi", "user-data")
			if(!fs.existsSync(folder)){
				fs.mkdirSync(folder)
			}
			folder = Path.join(folder, "com.kodhe.dynw")
			if(!fs.existsSync(folder)){
				fs.mkdirSync(folder)
			}

			folder = Path.join(folder, "sockets")
			if(!fs.existsSync(folder)){
				fs.mkdirSync(folder)
			}
			
			folder = Path.join(folder, res.id)
			if(!fs.existsSync(folder)){
				fs.mkdirSync(folder)
			}
			
			this.#socket_addresses = []
			for(let i=0;i<this.#config.cpus;i++){
				this.#socket_addresses.push(`unix://${folder}/${i}.socket`)
			}			
		}
	}

	get config(){
		return this.#config
	}


	get hosts(){
		return this.#hosts
	}

	get servers(){
		return this.#servers
	}

	get router(){
		if(!this.#router){
			this.#router = new Router(this)
		}
		return this.#router
	}

	get caddy(){
		return this.#caddy
	}

	

	async setCustomHandler(handler: ModuleInfo){
		this.#serverHandler = handler
		let keys = this.#servers.keys()
		for(let key of keys){
			await this.#servers.get(key).setCustomHandler(handler)
		}
	}

	async setStartupHandler(handler: ModuleInfo){
		this.#startupHandler = handler
		let keys = this.#servers.keys()
		for(let key of keys){
			await this.#servers.get(key).setStartupHandler(handler)
		}
	}


	async $addCluster(id: string, server: Server){
		this.#servers.set(id, server)

		
		if(this.#serverHandler){
			await server.setCustomHandler(this.#serverHandler)
		}
		if(this.#startupHandler){
			await server.setStartupHandler(this.#startupHandler)
		}
		if(this.#router){
			this.#router["$updateServer"](server)
		}
	}


	#processConfig(config: HostConfig, parent?: HostConfig){

		let hconfig = Object.assign({}, parent||{}, config)
		if(hconfig.config)
			return hconfig.config


		let ports = []
		if(hconfig.port) ports.push(hconfig.port)
		if(hconfig.https_port) ports.push(hconfig.https_port)
		const listen = ports.map((a) => ":" + a)

		let tls_connection_policies = [] 
		if(hconfig.ssl){

			let tls = this.#caddy.config.apps["tls"]			
			if(!tls){
				tls = {
					certificates: {
						load_files: [],
						load_pem: []
					}
				}
				this.#caddy.config.apps["tls"] = tls
			}
			
			/*
			if(hconfig.ssl.automate?.length){
				tls.certificates.automate = hconfig.ssl.automate
			}
			*/

			if(hconfig.names?.length){
				tls_connection_policies.push({
					match: {
						sni: hconfig.names
					},
					certificate_selection: {
						any_tag: []
					}
				})
			}


			if(hconfig.ssl.cert && hconfig.ssl.key){
				if(!hconfig.ssl["uid"]){
					Object.defineProperty(hconfig.ssl, "uid",{
						value: uniqid(),
						enumerable: false
					})
				}
				

				tls_connection_policies .push({
					"certificate_selection": {
						"any_tag": [hconfig.ssl["uid"]]
					}
				})
				

				let ispem = false
				let pemLoader = tls.certificates.load_files
				if(hconfig.ssl.cert.startsWith("-----BEGIN")){
					pemLoader = tls.certificates.load_pem
					ispem = true
				}
				let certconfig = pemLoader.filter((a) => a.tags[0] == hconfig.ssl["uid"])[0]
				if(!certconfig){
					certconfig = {
						certificate: '',
						key: '',
						tags: [hconfig.ssl["uid"]]
					}
					if(!ispem)
						certconfig.format = 'pem'
					tls.certificates.load_files.push(certconfig)
				}
				certconfig.certificate = hconfig.ssl.cert
				certconfig.key = hconfig.ssl.key
				
			}
			
		}

		
		let defRoute = Object.assign({}, this.#defaultRoute)
		let aroutes = []
		
		

		let nroutes = []
		if(hconfig.routes?.length){
			for(let route of hconfig.routes){		
				nroutes.push(route)
			}
		}

		if(hconfig.upstreams){
			defRoute.handle = [defRoute.handle[0]]
			defRoute.handle[0] = Object.assign({}, defRoute.handle[0])
			defRoute.handle[0].upstreams = hconfig.upstreams
		}

		if(hconfig.names?.length){
			let route1 = Object.assign({}, defRoute)
			route1.match = route1.match || []
			route1.match.push({
				host: hconfig.names
			})
			aroutes.push(route1)
		}
		aroutes.push(defRoute)


		let rconfig = {
			listen,
			routes: [
				...aroutes,
				...nroutes
			],
			tls_connection_policies
		}


		if(this.#router){
			let route : any 
			let currentRoutes = rconfig.routes
			rconfig.routes = []


			for(let routeHandler of this.#router.native){
				if(routeHandler["path"]){
					routeHandler["match"] = [
						{
							path: [routeHandler["path"]]
						}
					]
				}
				let h = routeHandler as RouteStaticHandler
				if(h.static){
					if(h.path && (h.path.indexOf("*") <= 0)){
						routeHandler["match"] = [
							{
								path: [h.path + "/*"]
							}
						]
					}
					let path_prefix = h.static.path_prefix
					if(!path_prefix && h.path){
						path_prefix = h.path
						if(path_prefix.endsWith("*")){
							path_prefix = Path.posix.dirname(path_prefix)
						}
					}
					route = {
						match: h.match,
						handle: [
							{
								handler:'rewrite',
								strip_path_prefix: path_prefix
							},
							{
								handler:'file_server',
								root: h.static.root
							}
						]
					}


					if(hconfig.names?.length){
						route.match = defRoute.match || []
						route.match.push({
							host: hconfig.names
						})
					}
					rconfig.routes.push(route)
				}
				else{
					if(routeHandler["config"]){
						rconfig.routes.push(routeHandler["config"])
					}
					else if(routeHandler["module"]){
						route = {
							match: routeHandler["match"],
							handle: [
								{
									handler:'reverse_proxy',
									upstreams: this.#defaultRoute.handle[0].upstreams,
									headers: {
										request: {
											set: {
												"caddy-web-url": ["{http.request.uri}"]
											},
											add: {
												"module-uid": [routeHandler["moduleId"]]
											}
										}
									}
								}
							]
						}
						if(hconfig.names?.length){
							route.match = defRoute.match || []
							route.match.push({
								host: hconfig.names
							})
						}
						rconfig.routes.push(route)
					}

				}
			}
			
			//defaultserver.routes.push(this.#defaultRoute)
			rconfig.routes.push(...currentRoutes)
		}

		return rconfig
	}

	async startServer(startup?: string){
		let client = await this.#connectTmux()
		if(!startup){
			startup = import.meta.url 
		}		
		let upstreams:any = []
		if(Os.platform() == "win32"){
		}
		else{
			upstreams = this.#socket_addresses.map((a) => ({dial: "unix/" + a.substring(7)}))
		}
		this.#defaultRoute = {
			handle: [
				{
					handler: "reverse_proxy",
					upstreams,
					headers: {
						request: {
							set: {
								"caddy-web-url": ["{http.request.uri}"]
							}
						}
					}
				}				
			]
			
		}
		this.#caddy.config.apps = {
			http: {
				http_port: this.#config.port,
				https_port: this.#config.https_port,
				servers: {
				}
			}
		}		
		//this.#caddy.config.apps.http.servers[this.#config.host] = this.#processConfig(this.#config)
		await this.$updateChanges()

		client.on("status:listen", (event) => {
			let id = event.id 
			let i = Number(id.substring(2))
			let addrBase64 = event.data
			let addr = JSON.parse(Buffer.from(addrBase64,'base64').toString())
			this.emit("cluster-address", {
				id,
				address: addr,
				number: i
			})
			if(addr.port){
				upstreams[i] = {
					dial: `${addr.address}:${addr.port}`
				}
			}
			this.updateChanges()
		})


		let createProcess = async (i: number) => {
			let proid = `ws${i}`
			let file = startup //import.meta.url
			let startupArgs = []
			if(this.startup.url && this.startup.method){
				startupArgs.push("--startup-url=" + this.startup.url)
				startupArgs.push("--startup-method=" + this.startup.method)
			}
			let pro = await client.createProcess({
				id: proid,
				autorestart: true,
				cmd: process.argv[0],
				args: [kawix.filename, file, "--dynwid=" + this.#rid, "--cluster", "--id=" + proid, "--address=" + this.#socket_addresses[i], ...startupArgs],
				env: Object.assign({}, process.env, {
					RUN_DYNW: 1
				})
			})
			await pro.start()
			//await pro.start(process.argv[0], )
		}

		for(let i=0;i<this.#config.cpus;i++){
			let pro = await client.getProcess(`ws${i}`)
			if(pro){
				await client.delete(pro.info.id)
			}
			await createProcess(i)
		}

		this.emit("clusters-started")
		
		let cmd = await this.#caddy.getCmd()
		if(this.#config.startup?.asroot){
			cmd.args = [cmd.bin, ...cmd.args]
			cmd.bin = "sudo"
		}

		let pro = await client.createProcess({
			id: "caddy",
			cmd: cmd.bin,
			autorestart: true,
			args: cmd.args,
			env: process.env
		})
		await pro.start()		
		//await pro.start(cmd.bin, cmd.args)
		this.emit("caddy-started")
	}

	updateChanges(){
		if(this.updateChanges["timer"]){
			clearTimeout(this.updateChanges["timer"])
		}
		this.updateChanges["timer"] = setTimeout(async ()=> {
			try{
				await this.$updateChanges()
			}catch(e){
				this.emit("caddy-error", e)
			}finally{
				delete this.updateChanges["timer"]
			}
		}, 100)
	}


	async $updateChanges(){
		this.#caddy.config.apps.http.servers = {}
		let defaultserver = this.#processConfig(this.#config)
		for(let hostConfig of this.#hosts){				
			//let c = 
			this.#caddy.config.apps.http.servers[hostConfig.host] = this.#processConfig(hostConfig, this.#config)

			/*if(!c.routes){
				c.routes = defaultserver.routes
			}*/
		}
		this.#caddy.config.apps.http.servers[this.#config.host] = defaultserver		
		await this.#caddy.update()
	}

	async #connectTmux(){
		let tmuxid = this.#rid		
		this.emit("tmux-check")
	
		
		// this starts a local server
		let client = this.client = new Tmux(tmuxid)
		/*
		if(await client.checkLocalServer()){
			throw Exception.create(`Tmux client with id ${tmuxid} yet started`).putCode("TMUX_STARTED")
		}
		*/
		
		

		let server = new MeshaServer()
		server.on("error", console.error)
		server.shared.set("getObject", ()=> client)
		server.shared.set("manager", this)

		/*
		server.on("client", (socket : ClientSocket)=>{
			let rpc = new RPC()
			rpc.channel = socket
			rpc.init()
			rpc.defaultScope.add("getObject", () => client)
			rpc.defaultScope.add("manager", this)
			socket.on("close", ()=>{
				//console.info("Closing client. Current scopes length:", rpc.$scopes.size)
				rpc = null
			})
		})		
		*/



		await client.init()
		await server.bind("local+" + tmuxid)
		this.emit("tmux-started")

		let onexit = async() => {
			console.info('> Closing process')
			try{ await client.close() }catch(e){}
			process.exit()
		}
		process.on("SIGINT", onexit)
		process.on("SIGTERM", onexit)
		process.on("SIGQUIT", onexit)		
		return client 
	}

}